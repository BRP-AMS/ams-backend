const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const XLSX       = require('xlsx');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { User, AttendanceRecord, Notification } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Email helper ─────────────────────────────────────────────────────────
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;
const sendMail = async (to, subject, html) => {
  if (!mailer) return;
  try { await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html }); }
  catch (err) { console.error('Email error:', err.message); }
};

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, message: errs.array()[0].msg, errors: errs.array() });
  next();
};

// GET /api/users - Admin/HR/Super Admin: all users | Manager: team
router.get('/', authenticate, authorize('manager', 'admin', 'hr'), async (req, res) => {
  try {
    let users;
    if (['admin', 'hr', 'super_admin'].includes(req.user.role)) {
      users = await User.aggregate([
        { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
        { $addFields: { manager_name: { $arrayElemAt: ['$manager.name', 0] } } },
        { $project: { manager: 0, password_hash: 0 } },
        { $sort: { role: 1, name: 1 } },
      ]);
    } else {
      users = await User
        .find({ manager_id: req.user.id })
        .select('-password_hash')
        .sort({ name: 1 })
        .lean();
    }
    res.json({ success: true, data: users.map(formatUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/users/managers - for admin/hr/super_admin dropdown
router.get('/managers', authenticate, authorize('admin', 'hr'), async (req, res) => {
  try {
    const managers = await User
      .find({ role: 'manager', is_active: 1 })
      .select('emp_id name email department')
      .lean();
    res.json({ success: true, data: managers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/users - Admin / Super Admin creates user
router.post('/', authenticate, authorize('admin'), [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }),
  body('empId').notEmpty().withMessage('Employee ID is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isIn(['employee', 'manager', 'admin', 'hr', 'super_admin']).withMessage('Invalid role'),
  body('department').notEmpty().withMessage('Department is required'),
], validate, async (req, res) => {
  try {
    const { name, email, empId, password, role, department, managerId, phone, assignedBlock, assignedDistrict } = req.body;

    const existingEmail = await User.findOne({ email }).lean();
    if (existingEmail) return res.status(409).json({ success: false, message: 'Email already exists' });

    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId) return res.status(409).json({ success: false, message: 'Employee ID already exists' });

    const id = uuidv4();
    await User.create({
      _id:               id,
      emp_id:            empId,
      name,
      email,
      password_hash:     bcrypt.hashSync(password, 10),
      role,
      department,
      manager_id:        managerId        || null,
      phone:             phone            || null,
      assigned_block:    assignedBlock    || null,
      assigned_district: assignedDistrict || null,
    });

    const user = await User.findById(id).lean();
    res.status(201).json({ success: true, message: 'User created successfully', data: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/users/:id/reset-password — must be before PUT /:id to avoid route shadowing
const DEFAULT_PASSWORD = 'R@m%Brp@26';
router.put('/:id/reset-password', authenticate, authorize('admin'), async (req, res) => {
  try {
    const target = await User.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (req.params.id === req.user.id)
      return res.status(400).json({ success: false, message: 'Use profile settings to change your own password' });

    const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    await User.findByIdAndUpdate(req.params.id, { $set: { password_hash: hash } });

    // Notify user — don't let notification failure block the response
    try {
      await Notification.create({
        _id: uuidv4(), user_id: target._id,
        title: 'Password Reset by Admin',
        message: 'Your password has been reset to the default by an administrator. Please log in and change it immediately.',
        type: 'warning', is_read: 0,
      });
    } catch (_) {}

    res.json({ success: true, message: `Password reset to default for ${target.name}` });
  } catch (err) {
    console.error('[reset-password]', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// PUT /api/users/:id - Update user
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { name, email, role, department, managerId, phone, isActive, assignedBlock, assignedDistrict } = req.body;
    const newManagerId = managerId        !== undefined ? (managerId        || null) : user.manager_id;
    const newBlock     = assignedBlock    !== undefined ? (assignedBlock    || null) : user.assigned_block;
    const newDistrict  = assignedDistrict !== undefined ? (assignedDistrict || null) : user.assigned_district;
    const newIsActive  = isActive         !== undefined ? isActive                  : user.is_active;

    const update = {
      name:              name       || user.name,
      email:             email      || user.email,
      role:              role       || user.role,
      department:        department || user.department,
      manager_id:        newManagerId,
      phone:             phone !== undefined ? (phone || null) : user.phone,
      is_active:         newIsActive,
      assigned_block:    newBlock,
      assigned_district: newDistrict,
    };
    await User.findByIdAndUpdate(req.params.id, { $set: update });

    // ── Notify affected parties after profile update ───────────────────────
    const targetRole = role || user.role;
    if (targetRole === 'employee') {
      const changes = [];

      if (newManagerId !== user.manager_id) {
        if (newManagerId) {
          const mgr = await User.findById(newManagerId).select('name').lean();
          if (mgr) {
            changes.push(`Reporting Manager assigned: ${mgr.name}`);
            await Notification.create({
              _id: uuidv4(), user_id: newManagerId,
              title: 'New Team Member Assigned',
              message: `${user.name} (${user.emp_id}) has been assigned to your team by admin.`,
              type: 'info', is_read: 0, link: '/manager/team',
            });
          }
        } else {
          changes.push('Reporting Manager removed');
        }
        if (user.manager_id && user.manager_id !== newManagerId) {
          await Notification.create({
            _id: uuidv4(), user_id: user.manager_id,
            title: 'Team Member Reassigned',
            message: `${user.name} (${user.emp_id}) has been reassigned by admin.`,
            type: 'warning', is_read: 0, link: '/manager/team',
          });
        }
      }

      if (newBlock     !== user.assigned_block)    changes.push(`Block: ${newBlock || 'removed'}`);
      if (newDistrict  !== user.assigned_district) changes.push(`District: ${newDistrict || 'removed'}`);
      if (newIsActive  !== user.is_active)          changes.push(newIsActive ? 'Account activated' : 'Account deactivated');

      if (changes.length) {
        await Notification.create({
          _id: uuidv4(), user_id: user._id,
          title: 'Your Profile Has Been Updated',
          message: `Admin has updated your profile — ${changes.join(', ')}.`,
          type: 'info', is_read: 0, link: '/profile',
        });
      }
    }

    const updated = await User.findById(req.params.id).lean();
    res.json({ success: true, message: 'User updated', data: formatUser(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/users/:id - Soft delete
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ success: false, message: 'Cannot deactivate yourself' });
    await User.findByIdAndUpdate(req.params.id, { $set: { is_active: 0 } });
    res.json({ success: true, message: 'User deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/users/team/attendance-summary - Manager view
router.get('/team/attendance-summary', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const today     = new Date().toISOString().split('T')[0];
    const matchStage = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };

    const summary = await User.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from:     'attendancerecords',
          let:      { empId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$emp_id', '$$empId'] },
              { $eq: ['$date', today] },
            ]}}}
          ],
          as: 'todayRecord',
        },
      },
      {
        $addFields: {
          today_status:  { $arrayElemAt: ['$todayRecord.status',    0] },
          today_duty:    { $arrayElemAt: ['$todayRecord.duty_type', 0] },
          checkin_time:  { $arrayElemAt: ['$todayRecord.checkin_time',  0] },
          checkout_time: { $arrayElemAt: ['$todayRecord.checkout_time', 0] },
        },
      },
      { $project: { password_hash: 0, todayRecord: 0 } },
      { $sort: { name: 1 } },
    ]);

    res.json({ success: true, data: summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/users/request-assignment ───────────────────────────────────
// Employee requests manager or block assignment — notifies all admins in-app + email
router.post('/request-assignment', authenticate, authorize('employee'), [
  body('type').isIn(['manager', 'block']).withMessage('type must be "manager" or "block"'),
  body('note').optional().trim(),
], validate, async (req, res) => {
  try {
    const { type, note } = req.body;
    const emp = await User.findById(req.user.id).select('name emp_id email').lean();
    const admins = await User.find({ role: 'admin', is_active: 1 }).select('_id email').lean();

    const label   = type === 'manager' ? 'Manager Assignment' : 'Block Assignment';
    const title   = `Request: ${label}`;
    const message = note
      ? `${emp.name} (${emp.emp_id}) requests a ${type === 'manager' ? 'reporting manager' : 'block'} assignment. Note: ${note}`
      : `${emp.name} (${emp.emp_id}) requests a ${type === 'manager' ? 'reporting manager' : 'block'} assignment.`;

    // In-app notifications for all admins
    if (admins.length) {
      await Notification.insertMany(admins.map(a => ({
        _id:     uuidv4(),
        user_id: a._id,
        title,
        message,
        type:    'warning',
        is_read: 0,
        link:    '/admin/users',
      })));
    }

    // Email to all admins
    const emailHtml = `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <h2 style="color:#0A1F44;margin-bottom:8px">${title}</h2>
        <p style="color:#64748B;font-size:14px;line-height:1.7">${message}</p>
        <div style="margin-top:24px;padding:16px;background:#FEF3C7;border-radius:12px;border:1px solid #FDE68A">
          <p style="color:#92400E;font-size:13px;margin:0">Please log in to the <strong>Admin Dashboard → Users</strong> to assign the ${type === 'manager' ? 'reporting manager' : 'block'} for this employee.</p>
        </div>
      </div>`;
    for (const admin of admins) {
      sendMail(admin.email, `[BRP AMS] ${title} — ${emp.name}`, emailHtml);
    }

    res.json({ success: true, message: `Request sent to admin${admins.length > 1 ? 's' : ''}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/users/request-location-change ───────────────────────────────
// Employee requests a change to their assigned block or district
router.post('/request-location-change', authenticate, authorize('employee'), [
  body('note').optional().trim(),
], validate, async (req, res) => {
  try {
    const { note } = req.body;
    const emp    = await User.findById(req.user.id).select('name emp_id email assigned_block assigned_district').lean();
    const admins = await User.find({ role: 'admin', is_active: 1 }).select('_id email').lean();

    const current = [emp.assigned_block, emp.assigned_district].filter(Boolean).join(' / ') || 'Not assigned';
    const title   = 'Request: Location / Block Change';
    const message = note
      ? `${emp.name} (${emp.emp_id}) requests a change to their assigned location (current: ${current}). Note: ${note}`
      : `${emp.name} (${emp.emp_id}) requests a change to their assigned location (current: ${current}).`;

    if (admins.length) {
      await Notification.insertMany(admins.map(a => ({
        _id: uuidv4(), user_id: a._id, title, message, type: 'warning', is_read: 0, link: '/admin/users',
      })));
    }

    const emailHtml = `
      <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <h2 style="color:#0A1F44;margin-bottom:8px">${title}</h2>
        <p style="color:#64748B;font-size:14px;line-height:1.7">${message}</p>
        <div style="margin-top:24px;padding:16px;background:#FEF3C7;border-radius:12px;border:1px solid #FDE68A">
          <p style="color:#92400E;font-size:13px;margin:0">Log in to <strong>Admin → Users</strong> and edit this employee's Block / District assignment.</p>
        </div>
      </div>`;
    for (const admin of admins) sendMail(admin.email, `[BRP AMS] ${title} — ${emp.name}`, emailHtml);

    res.json({ success: true, message: 'Location change request sent to admin.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/users/bulk-upload ───────────────────────────────────────────
// Super Admin: upload Excel with employee data and create/update users in bulk
// Expected columns: EmpId, Name, Email, Password, Role, Department, ManagerId, Phone, Block, District
router.post('/bulk-upload', authenticate, authorize('super_admin'), uploadMem.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });

  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) return res.status(400).json({ success: false, message: 'Empty spreadsheet' });

    const VALID_ROLES = ['employee', 'manager', 'admin', 'hr', 'super_admin'];
    const results = { created: 0, updated: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-based + header row

      const empId    = String(row['EmpId']      || row['empId']      || '').trim();
      const name     = String(row['Name']        || row['name']       || '').trim();
      const email    = String(row['Email']       || row['email']      || '').trim().toLowerCase();
      const password = String(row['Password']    || row['password']   || '').trim();
      const role     = String(row['Role']        || row['role']       || 'employee').trim().toLowerCase();
      const dept     = String(row['Department']  || row['department'] || '').trim();
      const phone    = String(row['Phone']       || row['phone']      || '').trim() || null;
      const block    = String(row['Block']       || row['block']      || '').trim() || null;
      const district = String(row['District']    || row['district']   || '').trim() || null;

      if (!empId || !name || !email || !dept) {
        results.errors.push({ row: rowNum, reason: 'Missing required field (EmpId/Name/Email/Department)' });
        results.skipped++;
        continue;
      }
      if (!VALID_ROLES.includes(role)) {
        results.errors.push({ row: rowNum, reason: `Invalid role: ${role}` });
        results.skipped++;
        continue;
      }

      const existing = await User.findOne({ $or: [{ emp_id: empId }, { email }] }).lean();
      if (existing) {
        // Update existing user (password only updated if provided)
        const update = { name, email, role, department: dept, phone, assigned_block: block, assigned_district: district };
        if (password && password.length >= 6) update.password_hash = bcrypt.hashSync(password, 10);
        await User.findByIdAndUpdate(existing._id, { $set: update });
        results.updated++;
      } else {
        if (!password || password.length < 6) {
          results.errors.push({ row: rowNum, reason: 'Password required for new user (min 6 chars)' });
          results.skipped++;
          continue;
        }
        await User.create({
          _id:               uuidv4(),
          emp_id:            empId,
          name,
          email,
          password_hash:     bcrypt.hashSync(password, 10),
          role,
          department:        dept,
          phone,
          assigned_block:    block,
          assigned_district: district,
        });
        results.created++;
      }
    }

    res.json({ success: true, message: 'Bulk upload complete', data: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during bulk upload' });
  }
});

// ── GET /api/users/bulk-upload/template ──────────────────────────────────
// Returns a downloadable Excel template for bulk user upload
router.get('/bulk-upload/template', authenticate, authorize('super_admin'), (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['EmpId', 'Name', 'Email', 'Password', 'Role', 'Department', 'Phone', 'Block', 'District'],
    ['EMP001', 'John Doe', 'john@example.com', 'Pass@123', 'employee', 'Finance', '9876543210', 'Block A', 'District 1'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="bulk_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

function formatUser(u) {
  return {
    id:            u._id || u.id,
    empId:         u.emp_id,
    name:          u.name,
    email:         u.email,
    role:          u.role,
    department:    u.department,
    managerId:     u.manager_id,
    managerName:   u.manager_name,
    phone:         u.phone,
    isActive:      !!u.is_active,
    createdAt:     u.created_at,
    assignedBlock:    u.assigned_block,
    assignedDistrict: u.assigned_district,
  };
}

module.exports = router;
