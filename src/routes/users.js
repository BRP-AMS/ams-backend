const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { User, AttendanceRecord } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/users - Admin: all users | Manager: team
router.get('/', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    let users;
    if (req.user.role === 'admin') {
      users = await User.aggregate([
        {
          $lookup: {
            from: 'users',
            localField: 'manager_id',
            foreignField: '_id',
            as: 'manager',
          },
        },
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

// GET /api/users/managers - for admin dropdown
router.get('/managers', authenticate, authorize('admin'), async (req, res) => {
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

// POST /api/users - Admin creates user
router.post('/', authenticate, authorize('admin'), [
  body('name').notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('empId').notEmpty(),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['employee', 'manager', 'admin']),
  body('department').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { name, email, empId, password, role, department, managerId, phone } = req.body;

    const existingEmail = await User.findOne({ email }).lean();
    if (existingEmail) return res.status(409).json({ success: false, message: 'Email already exists' });

    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId) return res.status(409).json({ success: false, message: 'Employee ID already exists' });

    const id = uuidv4();
    await User.create({
      _id:           id,
      emp_id:        empId,
      name,
      email,
      password_hash: bcrypt.hashSync(password, 10),
      role,
      department,
      manager_id:    managerId || null,
      phone:         phone || null,
    });

    const user = await User.findById(id).lean();
    res.status(201).json({ success: true, message: 'User created successfully', data: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/users/:id - Update user
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { name, email, role, department, managerId, phone, isActive } = req.body;
    await User.findByIdAndUpdate(req.params.id, {
      $set: {
        name:       name       || user.name,
        email:      email      || user.email,
        role:       role       || user.role,
        department: department || user.department,
        manager_id: managerId  || user.manager_id,
        phone:      phone      || user.phone,
        is_active:  isActive !== undefined ? isActive : user.is_active,
      }
    });

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

function formatUser(u) {
  return {
    id:          u._id || u.id,
    empId:       u.emp_id,
    name:        u.name,
    email:       u.email,
    role:        u.role,
    department:  u.department,
    managerId:   u.manager_id,
    managerName: u.manager_name,
    phone:       u.phone,
    isActive:    !!u.is_active,
    createdAt:   u.created_at,
  };
}

module.exports = router;
