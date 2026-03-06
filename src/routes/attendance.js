const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const { AttendanceRecord, User, Notification, AuditLog } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// Multer config for selfie uploads
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `selfie_${req.user.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// ── Helper: Notify user ──────────────────────────────────────────────────
const notify = async (userId, title, message, type = 'info', recordId = null) => {
  await Notification.create({ _id: uuidv4(), user_id: userId, title, message, type, related_record_id: recordId });
};

// ── Helper: build aggregation pipeline for record list ───────────────────
const recordListPipeline = (matchFilter, sortStage, skip, limit) => [
  { $match: matchFilter },
  { $lookup: { from: 'users', localField: 'emp_id',      foreignField: '_id', as: 'emp'            } },
  { $lookup: { from: 'users', localField: 'manager_id',  foreignField: '_id', as: 'manager'        } },
  { $lookup: { from: 'users', localField: 'actioned_by', foreignField: '_id', as: 'actioned_by_user' } },
  { $addFields: {
    emp_name:        { $arrayElemAt: ['$emp.name',               0] },
    emp_code:        { $arrayElemAt: ['$emp.emp_id',             0] },
    department:      { $arrayElemAt: ['$emp.department',         0] },
    manager_name:    { $arrayElemAt: ['$manager.name',           0] },
    actioned_by_name:{ $arrayElemAt: ['$actioned_by_user.name',  0] },
  }},
  { $project: { emp: 0, manager: 0, actioned_by_user: 0 } },
  { $sort: sortStage },
  { $skip: skip },
  { $limit: limit },
];

// ── GET /api/attendance ─────────────────────────────────────────────────
// Employee: own records | Manager: team records | Admin: all records
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, startDate, endDate, empId } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const matchFilter = {};

    if (req.user.role === 'employee') {
      matchFilter.emp_id = req.user.id;
    } else if (req.user.role === 'manager') {
      matchFilter.manager_id = req.user.id;
      if (empId) matchFilter.emp_id = empId;
    }
    // admin sees all

    if (status)    matchFilter.status = status;
    if (startDate) matchFilter.date = { ...matchFilter.date, $gte: startDate };
    if (endDate)   matchFilter.date = { ...matchFilter.date, $lte: endDate };

    const total   = await AttendanceRecord.countDocuments(matchFilter);
    const records = await AttendanceRecord.aggregate(
      recordListPipeline(matchFilter, { date: -1, created_at: -1 }, offset, limit)
    );

    res.json({
      success: true,
      data:    records.map(formatRecord),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/today ────────────────────────────────────────────
router.get('/today', authenticate, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows  = await AttendanceRecord.aggregate([
      { $match: { emp_id: req.user.id, date: today } },
      { $lookup: { from: 'users', localField: 'emp_id', foreignField: '_id', as: 'emp' } },
      { $addFields: {
          emp_name: { $arrayElemAt: ['$emp.name',   0] },
          emp_code: { $arrayElemAt: ['$emp.emp_id', 0] },
      }},
      { $project: { emp: 0 } },
    ]);
    res.json({ success: true, data: rows.length ? formatRecord(rows[0]) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/:id ──────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const rows = await AttendanceRecord.aggregate([
      { $match: { _id: req.params.id } },
      { $lookup: { from: 'users', localField: 'emp_id',      foreignField: '_id', as: 'emp'             } },
      { $lookup: { from: 'users', localField: 'manager_id',  foreignField: '_id', as: 'manager'         } },
      { $lookup: { from: 'users', localField: 'actioned_by', foreignField: '_id', as: 'actioned_by_user'} },
      { $addFields: {
          emp_name:         { $arrayElemAt: ['$emp.name',              0] },
          emp_code:         { $arrayElemAt: ['$emp.emp_id',            0] },
          department:       { $arrayElemAt: ['$emp.department',        0] },
          emp_phone:        { $arrayElemAt: ['$emp.phone',             0] },
          manager_name:     { $arrayElemAt: ['$manager.name',          0] },
          manager_email:    { $arrayElemAt: ['$manager.email',         0] },
          actioned_by_name: { $arrayElemAt: ['$actioned_by_user.name', 0] },
      }},
      { $project: { emp: 0, manager: 0, actioned_by_user: 0 } },
    ]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    const record = rows[0];

    // Access control
    if (req.user.role === 'employee' && record.emp_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Access denied' });
    if (req.user.role === 'manager' && record.manager_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    res.json({ success: true, data: formatRecord(record) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/attendance/checkin ─────────────────────────────────────────
router.post('/checkin', authenticate, authorize('employee'), upload.single('selfie'), [
  body('dutyType').isIn(['Office Duty', 'On Duty']),
  body('latitude').isFloat(),
  body('longitude').isFloat(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const today    = new Date().toISOString().split('T')[0];
    const existing = await AttendanceRecord.findOne({ emp_id: req.user.id, date: today }).lean();
    if (existing) return res.status(409).json({ success: false, message: 'Attendance already recorded for today' });

    const { dutyType, sector, description, latitude, longitude, locationAddress } = req.body;

    if (dutyType === 'On Duty' && !sector)
      return res.status(400).json({ success: false, message: 'Sector is required for On Duty' });

    // Get the current user's manager_id
    const currentUser = await User.findById(req.user.id).select('manager_id').lean();
    const managerId   = currentUser?.manager_id || null;

    const now = new Date();
    const id  = uuidv4();

    await AttendanceRecord.create({
      _id:              id,
      emp_id:           req.user.id,
      date:             today,
      duty_type:        dutyType,
      sector:           sector || null,
      description:      description || '',
      status:           'Draft',
      selfie_path:      req.file ? `/uploads/${req.file.filename}` : null,
      latitude:         parseFloat(latitude),
      longitude:        parseFloat(longitude),
      location_address: locationAddress || '',
      checkin_time:     now.toTimeString().substring(0, 5),
      checkin_lat:      parseFloat(latitude),
      checkin_lng:      parseFloat(longitude),
      manager_id:       managerId,
    });

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHECKIN', entity_type: 'attendance', entity_id: id });

    const record = await AttendanceRecord.findById(id).lean();
    res.status(201).json({ success: true, message: 'Check-in successful', data: formatRecord(record) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/attendance/:id/checkout ─────────────────────────────────────
router.put('/:id/checkout', authenticate, authorize('employee'), upload.single('checkoutSelfie'), async (req, res) => {
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record)              return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.checkout_time) return res.status(409).json({ success: false, message: 'Already checked out' });
    if (record.status !== 'Draft') return res.status(400).json({ success: false, message: 'Cannot checkout - record already submitted' });

    // ── 6-hour enforcement ─────────────────────────────────────────────────
    const now             = new Date();
    const checkinDateTime = new Date(`${record.date}T${record.checkin_time}:00`);
    const hoursElapsed    = (now - checkinDateTime) / (1000 * 60 * 60);
    if (hoursElapsed < 6) {
      const remaining = 6 - hoursElapsed;
      const h = Math.floor(remaining);
      const m = Math.floor((remaining - h) * 60);
      return res.status(400).json({
        success: false,
        message: `Check-out is locked for ${h}h ${m}m more (minimum 6 hours after check-in).`,
        hoursRemaining: remaining,
      });
    }

    const { latitude, longitude, locationAddress } = req.body;
    const checkoutSelfiePath = req.file ? `/uploads/${req.file.filename}` : null;

    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: {
        checkout_time:         now.toTimeString().substring(0, 5),
        checkout_lat:          parseFloat(latitude)  || record.latitude,
        checkout_lng:          parseFloat(longitude) || record.longitude,
        checkout_selfie_path:  checkoutSelfiePath,
        status:                'Pending',
        submitted_at:          now,
      }
    });

    // Notify manager
    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name').lean();
      await notify(record.manager_id, 'New Attendance Pending', `${emp.name}'s attendance for ${record.date} requires your approval`, 'warning', record._id);
    }

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHECKOUT', entity_type: 'attendance', entity_id: record._id });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Checked out and submitted for approval', data: formatRecord(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/attendance/:id/approve ──────────────────────────────────────
router.put('/:id/approve', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    if (req.user.role === 'manager') {
      if (record.manager_id !== req.user.id)
        return res.status(403).json({ success: false, message: 'Not your team member' });
      if (!['Pending', 'Rejected'].includes(record.status))
        return res.status(400).json({ success: false, message: 'Record cannot be approved in current state' });
    }

    const isAdmin      = req.user.role === 'admin';
    const updateFields = {
      status:       'Approved',
      manager_remark: remark || '',
      actioned_by:  req.user.id,
      actioned_at:  new Date(),
    };
    if (isAdmin) updateFields.admin_remark = remark || '';

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: updateFields });
    await notify(record.emp_id, 'Attendance Approved ✓', `Your attendance for ${record.date} has been approved`, 'success', record._id);
    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id,
      action: isAdmin ? 'ADMIN_OVERRIDE_APPROVE' : 'APPROVE',
      entity_type: 'attendance', entity_id: record._id,
      old_value: record.status, new_value: 'Approved',
    });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Record approved successfully', data: formatRecord(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/attendance/:id/reject ───────────────────────────────────────
router.put('/:id/reject', authenticate, authorize('manager', 'admin'), [
  body('remark').notEmpty().withMessage('Rejection reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    if (req.user.role === 'manager' && record.manager_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Not your team member' });

    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: { status: 'Rejected', manager_remark: remark, actioned_by: req.user.id, actioned_at: new Date() }
    });
    await notify(record.emp_id, 'Attendance Rejected ✗', `Your attendance for ${record.date} was rejected: ${remark}`, 'error', record._id);
    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id, action: 'REJECT',
      entity_type: 'attendance', entity_id: record._id,
      old_value: record.status, new_value: 'Rejected',
    });

    res.json({ success: true, message: 'Record rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/stats/summary ───────────────────────────────────
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, empId } = req.query;
    const matchFilter = {};

    if (req.user.role === 'employee') {
      matchFilter.emp_id = req.user.id;
    } else if (req.user.role === 'manager') {
      matchFilter.manager_id = req.user.id;
      if (empId) matchFilter.emp_id = empId;
    }
    if (startDate) matchFilter.date = { ...matchFilter.date, $gte: startDate };
    if (endDate)   matchFilter.date = { ...matchFilter.date, $lte: endDate };

    const result = await AttendanceRecord.aggregate([
      { $match: matchFilter },
      { $group: {
        _id:         null,
        total:       { $sum: 1 },
        approved:    { $sum: { $cond: [{ $eq: ['$status',    'Approved']   }, 1, 0] } },
        pending:     { $sum: { $cond: [{ $eq: ['$status',    'Pending']    }, 1, 0] } },
        rejected:    { $sum: { $cond: [{ $eq: ['$status',    'Rejected']   }, 1, 0] } },
        on_duty:     { $sum: { $cond: [{ $eq: ['$duty_type', 'On Duty']    }, 1, 0] } },
        office_duty: { $sum: { $cond: [{ $eq: ['$duty_type', 'Office Duty']}, 1, 0] } },
      }},
      { $project: { _id: 0 } },
    ]);

    const stats = result[0] || { total: 0, approved: 0, pending: 0, rejected: 0, on_duty: 0, office_duty: 0 };
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Format helper ────────────────────────────────────────────────────────
function formatRecord(r) {
  return {
    id:                  r._id || r.id,
    empId:               r.emp_id,
    empName:             r.emp_name,
    empCode:             r.emp_code,
    department:          r.department,
    date:                r.date,
    dutyType:            r.duty_type,
    sector:              r.sector,
    description:         r.description,
    status:              r.status,
    selfiePath:          r.selfie_path,
    latitude:            r.latitude,
    longitude:           r.longitude,
    locationAddress:     r.location_address,
    checkinTime:         r.checkin_time,
    checkoutTime:        r.checkout_time,
    checkoutSelfiePath:  r.checkout_selfie_path,
    managerId:           r.manager_id,
    managerName:         r.manager_name,
    managerRemark:       r.manager_remark,
    adminRemark:         r.admin_remark,
    actionedBy:          r.actioned_by,
    actionedByName:      r.actioned_by_name,
    actionedAt:          r.actioned_at,
    submittedAt:         r.submitted_at,
    createdAt:           r.created_at,
  };
}

module.exports = router;
