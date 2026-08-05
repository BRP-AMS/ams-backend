const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { ODARequest, User, Notification } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const istDateStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ── POST /api/oda — Employee raises an ODA request ────────────────────────
router.post('/', authenticate, authorize('employee'), [
  body('from_date').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('to_date').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('duty_type').isIn(['Training', 'Head Office Visit', 'District Meeting', 'Election Duty', 'Other']),
  body('location_name').trim().notEmpty(),
  body('reason').trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { from_date, to_date, duty_type, location_name, reason } = req.body;
    const today = istDateStr();

    if (to_date < from_date)
      return res.status(400).json({ success: false, message: 'to_date must be ≥ from_date' });

    // Retroactive limit: can't request more than 3 days in the past
    const threeDaysAgo = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const limitStr = threeDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (from_date < limitStr)
      return res.status(400).json({ success: false, message: 'Cannot request ODA more than 3 days in the past' });

    const req_id = uuidv4();
    await ODARequest.create({
      _id: req_id, emp_id: req.user.id,
      from_date, to_date, duty_type, location_name: location_name.trim(), reason: reason.trim(),
      status: 'pending',
    });

    // Notify all admins
    const admins = await User.find({ role: { $in: ['admin', 'super_admin'] }, is_active: 1 }).select('_id').lean();
    const emp = await User.findById(req.user.id).select('name emp_id').lean();
    await Promise.all(admins.map(a => Notification.create({
      _id: uuidv4(), user_id: a._id,
      title: '📍 Away Duty Request',
      message: `${emp?.name || 'An employee'} (${emp?.emp_id}) requested Away Duty for ${from_date === to_date ? from_date : `${from_date} to ${to_date}`} at ${location_name}.`,
      type: 'info', link: '/admin/oda',
    })));

    res.status(201).json({ success: true, message: 'Request submitted. Waiting for admin approval.', data: { id: req_id } });
  } catch (err) {
    console.error('[ODA Create]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/oda/active-today — Does this employee have an approved ODA today? ─
router.get('/active-today', authenticate, authorize('employee'), async (req, res) => {
  try {
    const today = istDateStr();
    const oda = await ODARequest.findOne({
      emp_id: req.user.id, status: 'approved',
      from_date: { $lte: today }, to_date: { $gte: today },
    }).lean();
    res.json({ success: true, active: !!oda, oda: oda || null });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/oda — List requests (employee: own; admin: all) ──────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const filter = req.user.role === 'employee' ? { emp_id: req.user.id } : {};
    if (req.query.status) filter.status = req.query.status;

    const requests = await ODARequest.find(filter).sort({ created_at: -1 }).limit(200).lean();

    // Attach employee info for admin view
    if (req.user.role !== 'employee') {
      const empIds = [...new Set(requests.map(r => r.emp_id))];
      const emps = await User.find({ _id: { $in: empIds } }).select('name emp_id department designation').lean();
      const empMap = Object.fromEntries(emps.map(e => [e._id, e]));
      requests.forEach(r => { r.emp = empMap[r.emp_id] || null; });
    }

    res.json({ success: true, data: requests });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/oda/:id/approve — Admin approves ────────────────────────────
router.put('/:id/approve', authenticate, authorize('admin', 'super_admin'), [
  body('remark').optional().trim(),
], async (req, res) => {
  try {
    const oda = await ODARequest.findById(req.params.id);
    if (!oda) return res.status(404).json({ success: false, message: 'Request not found' });
    if (oda.status !== 'pending') return res.status(400).json({ success: false, message: 'Already actioned' });

    oda.status       = 'approved';
    oda.approved_by  = req.user.id;
    oda.admin_remark = req.body.remark?.trim() || null;
    oda.actioned_at  = new Date();
    await oda.save();

    await Notification.create({
      _id: uuidv4(), user_id: oda.emp_id,
      title: '✅ Away Duty Approved',
      message: `Your Away Duty request for ${oda.from_date === oda.to_date ? oda.from_date : `${oda.from_date} to ${oda.to_date}`} at ${oda.location_name} has been approved. You can check in from that location.`,
      type: 'success', link: '/employee/attendance',
    });

    res.json({ success: true, message: 'Approved successfully' });
  } catch (err) {
    console.error('[ODA Approve]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/oda/:id/reject — Admin rejects ──────────────────────────────
router.put('/:id/reject', authenticate, authorize('admin', 'super_admin'), [
  body('remark').optional().trim(),
], async (req, res) => {
  try {
    const oda = await ODARequest.findById(req.params.id);
    if (!oda) return res.status(404).json({ success: false, message: 'Request not found' });
    if (oda.status !== 'pending') return res.status(400).json({ success: false, message: 'Already actioned' });

    oda.status       = 'rejected';
    oda.approved_by  = req.user.id;
    oda.admin_remark = req.body.remark?.trim() || null;
    oda.actioned_at  = new Date();
    await oda.save();

    await Notification.create({
      _id: uuidv4(), user_id: oda.emp_id,
      title: '❌ Away Duty Rejected',
      message: `Your Away Duty request for ${oda.from_date === oda.to_date ? oda.from_date : `${oda.from_date} to ${oda.to_date}`} at ${oda.location_name} was rejected.${oda.admin_remark ? ` Reason: ${oda.admin_remark}` : ''}`,
      type: 'error', link: '/employee/attendance',
    });

    res.json({ success: true, message: 'Rejected' });
  } catch (err) {
    console.error('[ODA Reject]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/oda/:id — Employee cancels pending request ───────────────
router.delete('/:id', authenticate, authorize('employee'), async (req, res) => {
  try {
    const oda = await ODARequest.findOne({ _id: req.params.id, emp_id: req.user.id });
    if (!oda)              return res.status(404).json({ success: false, message: 'Request not found' });
    if (oda.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending requests can be cancelled' });
    await ODARequest.deleteOne({ _id: req.params.id });
    res.json({ success: true, message: 'Request cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
