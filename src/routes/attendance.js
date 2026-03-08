const express      = require('express');
const router       = express.Router();
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const nodemailer   = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const { AttendanceRecord, User, Notification, AuditLog } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// ── Email helper (graceful — no crash if SMTP not configured) ────────────
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

const sendMail = async (to, subject, html) => {
  if (!mailer) return;
  try {
    await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
  } catch (err) {
    console.error('Email send error:', err.message);
  }
};

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
const notify = async (userId, title, message, type = 'info', recordId = null, link = null) => {
  await Notification.create({ _id: uuidv4(), user_id: userId, title, message, type, related_record_id: recordId, link });
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
    const { status, startDate, endDate, empId, onlyLeaves } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const matchFilter = {};

    if (req.user.role === 'employee') {
      matchFilter.emp_id = req.user.id;
    } else if (req.user.role === 'manager') {
      matchFilter.manager_id = req.user.id;
      if (empId) matchFilter.emp_id = empId;
    } else if (['admin', 'hr', 'super_admin'].includes(req.user.role)) {
      if (empId) matchFilter.emp_id = empId;
    }
    // admin / hr / super_admin sees all (with optional empId filter)

    if (onlyLeaves === 'true') matchFilter.leave_type = { $ne: null };
    if (status) {
      if (onlyLeaves === 'true') matchFilter.leave_status = status;
      else matchFilter.status = status;
    }
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

    const { dutyType, sector, description, latitude, longitude, locationAddress, capturedAt, capturedDate } = req.body;

    if (dutyType === 'On Duty' && !sector)
      return res.status(400).json({ success: false, message: 'Sector is required for On Duty' });

    // Get the current user's manager_id
    const currentUser = await User.findById(req.user.id).select('manager_id').lean();
    const managerId   = currentUser?.manager_id || null;

    const now = new Date();
    const id  = uuidv4();

    // Support offline sync: capturedAt (HH:MM) and capturedDate (YYYY-MM-DD) override server time
    const timeRe = /^\d{2}:\d{2}$/;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const checkinTime = (capturedAt && timeRe.test(capturedAt)) ? capturedAt : now.toTimeString().substring(0, 5);
    const checkinDate = (capturedDate && dateRe.test(capturedDate)) ? capturedDate : today;

    await AttendanceRecord.create({
      _id:              id,
      emp_id:           req.user.id,
      date:             checkinDate,
      duty_type:        dutyType,
      sector:           sector || null,
      description:      description || '',
      status:           'Draft',
      selfie_path:      req.file ? `/uploads/${req.file.filename}` : null,
      latitude:         parseFloat(latitude),
      longitude:        parseFloat(longitude),
      location_address: locationAddress || '',
      checkin_time:     checkinTime,
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

// ── POST /api/attendance/apply-leave ─────────────────────────────────────
// Employee applies for a full-day leave (no check-in required), supports date range
router.post('/apply-leave', authenticate, authorize('employee'), [
  body('date').isDate().withMessage('Valid start date required'),
  body('endDate').optional().isDate().withMessage('Valid end date required'),
  body('leaveType').isIn(['Sick Leave', 'Casual Leave', 'Half Day', 'Emergency Leave']).withMessage('Invalid leave type'),
  body('reason').notEmpty().withMessage('Reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { date, endDate, leaveType, reason } = req.body;
    const finalEndDate = endDate || date;

    if (finalEndDate < date) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });

    // Allow up to 30 days in the past and 10 days in advance
    const today   = new Date(); today.setHours(0, 0, 0, 0);
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - 30);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + 10);
    const startD  = new Date(date);
    const endD    = new Date(finalEndDate);
    if (startD < minDate) return res.status(400).json({ success: false, message: 'Leave cannot be applied more than 30 days in the past' });
    if (endD   > maxDate) return res.status(400).json({ success: false, message: 'Leave can only be planned up to 10 days in advance' });

    const currentUser = await User.findById(req.user.id).select('manager_id name').lean();
    const managerId   = currentUser?.manager_id || null;
    const todayISO    = today.toISOString().split('T')[0];

    // Build list of dates in range
    const dates = [];
    const cur = new Date(startD);
    while (cur <= endD) {
      dates.push(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }

    const created = [];
    const skipped = [];

    for (const d of dates) {
      const existing = await AttendanceRecord.findOne({ emp_id: req.user.id, date: d }).lean();
      if (existing) { skipped.push(d); continue; }
      const id = uuidv4();
      await AttendanceRecord.create({
        _id: id, emp_id: req.user.id, date: d, duty_type: 'Leave',
        status: 'Pending', manager_id: managerId,
        leave_type: leaveType, leave_reason: reason,
        leave_status: 'Pending', submitted_at: new Date(),
      });
      await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'APPLY_LEAVE', entity_type: 'attendance', entity_id: id, new_value: leaveType });
      created.push({ id, date: d });
    }

    if (created.length === 0) {
      return res.status(409).json({ success: false, message: `Records already exist for all selected dates${skipped.length ? ': ' + skipped.join(', ') : ''}` });
    }

    if (managerId) {
      const dateRange = date === finalEndDate ? date : `${date} to ${finalEndDate}`;
      await notify(managerId, `${leaveType} Request`, `${currentUser.name} has applied for ${leaveType} (${created.length} day${created.length > 1 ? 's' : ''}) on ${dateRange}: ${reason}`, 'warning', created[0].id, '/manager/queue');
      const manager = await User.findById(managerId).select('email name').lean();
      if (manager?.email) {
        await sendMail(
          manager.email,
          `[AMS] ${leaveType} Request – ${currentUser.name} (${dateRange})`,
          `<p>Hi ${manager.name},</p>
           <p><strong>${currentUser.name}</strong> has applied for <strong>${leaveType}</strong> from <strong>${date}</strong> to <strong>${finalEndDate}</strong> (${created.length} day${created.length > 1 ? 's' : ''}).</p>
           <p><strong>Reason:</strong> ${reason}</p>
           ${skipped.length ? `<p><em>Note: ${skipped.length} date(s) were skipped as records already existed.</em></p>` : ''}
           <p>Please review this in the AMS Manager Dashboard.</p>`
        );
      }
    }

    // Return the today record if today falls in range (for frontend step update)
    let todayRecord = null;
    if (todayISO >= date && todayISO <= finalEndDate) {
      const rec = await AttendanceRecord.findOne({ emp_id: req.user.id, date: todayISO }).lean();
      if (rec) todayRecord = formatRecord(rec);
    }

    res.status(201).json({
      success: true,
      message: `Leave application submitted for ${created.length} day${created.length > 1 ? 's' : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`,
      count: created.length,
      skipped,
      todayRecord,
    });
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

    // ── 4-hour enforcement ─────────────────────────────────────────────────
    const now             = new Date();
    const checkinDateTime = new Date(`${record.date}T${record.checkin_time}:00`);
    // For offline sync: use capturedAt time if provided and valid (must be in the past)
    const capturedAtBody = req.body?.capturedAt;
    const timeReCheck    = /^\d{2}:\d{2}$/;
    const effectiveNow   = (capturedAtBody && timeReCheck.test(capturedAtBody))
      ? (() => { const d = new Date(`${record.date}T${capturedAtBody}:00`); return d <= now ? d : now; })()
      : now;
    const hoursElapsed    = (effectiveNow - checkinDateTime) / (1000 * 60 * 60);
    if (hoursElapsed < 4) {
      const remaining = 4 - hoursElapsed;
      const h = Math.floor(remaining);
      const m = Math.floor((remaining - h) * 60);
      return res.status(400).json({
        success: false,
        message: `Check-out is locked for ${h}h ${m}m more (minimum 4 hours after check-in).`,
        hoursRemaining: remaining,
      });
    }

    const { latitude, longitude, locationAddress, capturedAt } = req.body;
    const checkoutSelfiePath = req.file ? `/uploads/${req.file.filename}` : null;

    // Support offline sync: use capturedAt (HH:MM) if provided (must be in the past)
    const timeRe = /^\d{2}:\d{2}$/;
    let checkoutTime = now.toTimeString().substring(0, 5);
    let workedHours  = Math.round(hoursElapsed * 100) / 100;
    if (capturedAt && timeRe.test(capturedAt)) {
      const capturedDT = new Date(`${record.date}T${capturedAt}:00`);
      if (capturedDT <= now) {
        checkoutTime = capturedAt;
        workedHours  = Math.round(((capturedDT - checkinDateTime) / 3600000) * 100) / 100;
      }
    }

    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: {
        checkout_time:         checkoutTime,
        checkout_lat:          parseFloat(latitude)  || record.latitude,
        checkout_lng:          parseFloat(longitude) || record.longitude,
        checkout_selfie_path:  checkoutSelfiePath,
        status:                'Pending',
        submitted_at:          now,
        worked_hours:          workedHours,
      }
    });

    // Notify manager
    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name').lean();
      await notify(record.manager_id, 'New Attendance Pending', `${emp.name}'s attendance for ${record.date} requires your approval`, 'warning', record._id, '/manager/queue');
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
    if (record.leave_type) updateFields.leave_status = 'Approved';

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: updateFields });
    const notifTitle = record.leave_type ? `Leave Approved ✓` : 'Attendance Approved ✓';
    const notifMsg   = record.leave_type
      ? `Your ${record.leave_type} request for ${record.date} has been approved`
      : `Your attendance for ${record.date} has been approved`;
    await notify(record.emp_id, notifTitle, notifMsg, 'success', record._id, '/employee/history');
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

    const rejectFields = { status: 'Rejected', manager_remark: remark, actioned_by: req.user.id, actioned_at: new Date() };
    if (record.leave_type) rejectFields.leave_status = 'Rejected';
    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: rejectFields });
    const rejectTitle = record.leave_type ? `Leave Rejected ✗` : 'Attendance Rejected ✗';
    const rejectMsg   = record.leave_type
      ? `Your ${record.leave_type} request for ${record.date} was rejected: ${remark}`
      : `Your attendance for ${record.date} was rejected: ${remark}`;
    await notify(record.emp_id, rejectTitle, rejectMsg, 'error', record._id, '/employee/history');
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

// ── PUT /api/attendance/:id/hr-override ──────────────────────────────────
// HR / Super Admin: override a Rejected record back to Approved with mandatory remark
router.put('/:id/hr-override', authenticate, authorize('hr'), [
  body('remark').notEmpty().withMessage('HR override remark is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    if (record.status !== 'Rejected')
      return res.status(400).json({ success: false, message: 'HR override only allowed on Rejected records' });

    const updateFields = {
      status:         'Approved',
      hr_override:    true,
      hr_remark:      remark,
      hr_actioned_by: req.user.id,
      hr_actioned_at: new Date(),
    };
    if (record.leave_type) updateFields.leave_status = 'Approved';

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: updateFields });

    await notify(
      record.emp_id,
      'Attendance Override by HR ✓',
      `Your ${record.leave_type ? record.leave_type + ' request' : 'attendance'} for ${record.date} has been approved via HR override. Remark: ${remark}`,
      'success', record._id, '/employee/history'
    );

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id, action: 'HR_OVERRIDE_APPROVE',
      entity_type: 'attendance', entity_id: record._id,
      old_value: 'Rejected', new_value: 'Approved',
    });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'HR override applied successfully', data: formatRecord(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/attendance/:id/leave-request ────────────────────────────────
router.put('/:id/leave-request', authenticate, authorize('employee'), [
  body('leaveType').isIn(['Sick Leave', 'Casual Leave', 'Half Day', 'Emergency Leave']).withMessage('Invalid leave type'),
  body('reason').notEmpty().withMessage('Reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { leaveType, reason } = req.body;
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (!record.checkout_time) return res.status(400).json({ success: false, message: 'Must checkout before requesting leave' });
    if (record.leave_type) return res.status(409).json({ success: false, message: 'Leave already requested for this record' });

    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: { leave_type: leaveType, leave_reason: reason, leave_status: 'Pending' }
    });

    // Notify manager
    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name email').lean();
      await notify(record.manager_id, `${leaveType} Request`, `${emp.name} has requested ${leaveType} for ${record.date}: ${reason}`, 'warning', record._id, '/manager/queue');

      // Email manager
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) {
        await sendMail(
          manager.email,
          `[AMS] ${leaveType} Request – ${emp.name}`,
          `<p>Hi ${manager.name},</p>
           <p><strong>${emp.name}</strong> has submitted a <strong>${leaveType}</strong> request for <strong>${record.date}</strong>.</p>
           <p><strong>Reason:</strong> ${reason}</p>
           <p><strong>Worked hours:</strong> ${record.worked_hours ?? '—'} hrs</p>
           <p>Please review this in the AMS Manager Dashboard.</p>`
        );
      }
    }

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'LEAVE_REQUEST', entity_type: 'attendance', entity_id: record._id, new_value: leaveType });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Leave request submitted', data: formatRecord(updated) });
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
        _id:             null,
        total:           { $sum: 1 },
        approved:        { $sum: { $cond: [{ $eq: ['$status',     'Approved']        }, 1, 0] } },
        pending:         { $sum: { $cond: [{ $eq: ['$status',     'Pending']         }, 1, 0] } },
        rejected:        { $sum: { $cond: [{ $eq: ['$status',     'Rejected']        }, 1, 0] } },
        on_duty:         { $sum: { $cond: [{ $eq: ['$duty_type',  'On Duty']         }, 1, 0] } },
        office_duty:     { $sum: { $cond: [{ $eq: ['$duty_type',  'Office Duty']     }, 1, 0] } },
        sick_leave:      { $sum: { $cond: [{ $eq: ['$leave_type', 'Sick Leave']      }, 1, 0] } },
        casual_leave:    { $sum: { $cond: [{ $eq: ['$leave_type', 'Casual Leave']    }, 1, 0] } },
        half_day:        { $sum: { $cond: [{ $eq: ['$leave_type', 'Half Day']        }, 1, 0] } },
        emergency_leave: { $sum: { $cond: [{ $eq: ['$leave_type', 'Emergency Leave'] }, 1, 0] } },
        total_leaves:    { $sum: { $cond: [{ $ne:  ['$leave_type', null]             }, 1, 0] } },
        lop_count:       { $sum: { $cond: [{ $eq: ['$status',     'Rejected']        }, 1, 0] } },
      }},
      { $project: { _id: 0 } },
    ]);

    const stats = result[0] || { total: 0, approved: 0, pending: 0, rejected: 0, on_duty: 0, office_duty: 0, sick_leave: 0, casual_leave: 0, half_day: 0, emergency_leave: 0, total_leaves: 0, lop_count: 0 };
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/attendance/:id/reapply ──────────────────────────────────────
router.put('/:id/reapply', authenticate, authorize('employee'), upload.array('reapplyDocs', 10), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: 'Reason is required' });

    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.status !== 'Rejected') return res.status(400).json({ success: false, message: 'Only rejected records can be re-applied' });

    const docPaths = (req.files || []).map(f => f.filename);

    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: {
        status:         'Pending',
        manager_remark: null,
        reapply_reason: reason.trim(),
        reapply_docs:   docPaths,
        reapplied_at:   new Date(),
        submitted_at:   new Date(),
      }
    });

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name email').lean();
      await notify(record.manager_id, 'Re-application Submitted', `${emp.name} has re-submitted attendance for ${record.date} after rejection. Reason: ${reason}`, 'info', record._id, '/manager/queue');

      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) {
        await sendMail(
          manager.email,
          `[AMS] Re-application – ${emp.name} (${record.date})`,
          `<p>Hi ${manager.name},</p>
           <p><strong>${emp.name}</strong> has re-submitted their attendance for <strong>${record.date}</strong> after it was rejected.</p>
           <p><strong>Re-apply Reason:</strong> ${reason}</p>
           <p><strong>Supporting documents:</strong> ${docPaths.length} file(s) attached</p>
           <p>Please review this in the AMS Manager Dashboard.</p>`
        );
      }
    }

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'REAPPLY', entity_type: 'attendance', entity_id: record._id, new_value: reason });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Re-application submitted successfully', data: formatRecord(updated) });
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
    workedHours:         r.worked_hours,
    isAutoCheckout:      r.is_auto_checkout,
    checkoutRemarks:     r.checkout_remarks,
    leaveType:           r.leave_type,
    leaveReason:         r.leave_reason,
    leaveStatus:         r.leave_status,
    reapplyReason:       r.reapply_reason,
    reapplyDocs:         r.reapply_docs || [],
    reappliedAt:         r.reapplied_at,
    hrOverride:          r.hr_override,
    hrRemark:            r.hr_remark,
    hrActionedBy:        r.hr_actioned_by,
    hrActionedAt:        r.hr_actioned_at,
  };
}

module.exports = router;
