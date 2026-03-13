const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { User, AuditLog, RevokedToken } = require('../models/database');
const { authenticate } = require('../middleware/auth');

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty())
    return res.status(422).json({ success: false, message: errs.array()[0].msg });
  next();
};


router.post('/register-super-admin', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, all_lowercase: true }).withMessage('Valid email required'),
  body('empId').trim().notEmpty().withMessage('Employee ID is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('department').trim().notEmpty().withMessage('Department is required'),
], validate, async (req, res) => {
  try {
    // ── Secret key guard ───────────────────────────────────────────────────
    const secret         = req.headers['x-register-secret'];
    const expectedSecret = process.env.REGISTER_SECRET;

    if (!expectedSecret) {
      return res.status(500).json({ success: false, message: 'REGISTER_SECRET not set in .env' });
    }
    if (!secret || secret !== expectedSecret) {
      return res.status(403).json({ success: false, message: 'Invalid or missing register secret' });
    }

    const { name, email, empId, password, phone, department } = req.body;

    // ── Prevent duplicate email ────────────────────────────────────────────
    const existingEmail = await User.findOne({ email }).lean();
    if (existingEmail)
      return res.status(409).json({ success: false, message: 'Email already exists' });

    // ── Prevent duplicate empId ────────────────────────────────────────────
    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId)
      return res.status(409).json({ success: false, message: 'Employee ID already exists' });

    // ── Create super_admin ─────────────────────────────────────────────────
    const id = uuidv4();
    await User.create({
      _id:           id,
      emp_id:        empId,
      name,
      email,
      password_hash: bcrypt.hashSync(password, 10),
      role:          'super_admin',
      department,
      phone:         phone || null,
      is_active:     1,
      email_verified: true,
      phone_verified: true,
    });

    const user = await User.findById(id).lean();

    res.status(201).json({
      success: true,
      message: 'Super Admin registered successfully',
      data: {
        id:         user._id,
        empId:      user.emp_id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        department: user.department,
        phone:      user.phone,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, all_lowercase: true }),
  body('password').notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ success: false, message: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user._id, role: user.role, emp_id: user.emp_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    await AuditLog.create({
      _id: uuidv4(), user_id: user._id,
      action: 'LOGIN', ip_address: req.ip,
    });
// Lookup manager name for login response
    let managerName = null, managerEmail = null;
    if (user.manager_id) {
      const mgr = await User.findById(user.manager_id).select('name email').lean();
      if (mgr) { managerName = mgr.name; managerEmail = mgr.email; }
    }
    res.json({
      success: true,
      token,
      user: {
        id:         user._id,
        empId:      user.emp_id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        department: user.department,
        blockName:  user.block_name     || null,
        managerId:   user.manager_id,
        managerName,  
        managerEmail,
        phone:      user.phone          || null,
        emailVerified: user.email_verified,
        phoneVerified: user.phone_verified,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.token).digest('hex');
    await RevokedToken.updateOne(
      { _id: tokenHash },
      { $setOnInsert: { _id: tokenHash, revoked_at: new Date() } },
      { upsert: true }
    );
    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id,
      action: 'LOGOUT', ip_address: req.ip,
    });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const [user] = await User.aggregate([
      { $match: { _id: req.user.id } },
      { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
      { $addFields: {
          manager_name:  { $arrayElemAt: ['$manager.name',  0] },
          manager_email: { $arrayElemAt: ['$manager.email', 0] },
      }},
      { $project: { manager: 0, password_hash: 0 } },
    ]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({
      success: true,
      user: {
        id:           user._id,
        empId:        user.emp_id,
        name:         user.name,
        email:        user.email,
        role:         user.role,
        department:   user.department,
        blockName:    user.block_name    || null,
        managerId:     user.manager_id,
        managerName:   user.manager_name,
         managerEmail:  user.manager_email,
        phone:        user.phone         || null,
        emailVerified: user.email_verified,
        phoneVerified: user.phone_verified,
        createdAt:    user.created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/auth/change-password
// ─────────────────────────────────────────────────────────────────────────────
router.put('/change-password', authenticate, [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
], validate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!bcrypt.compareSync(req.body.currentPassword, user.password_hash))
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    await User.findByIdAndUpdate(req.user.id, {
      $set: { password_hash: bcrypt.hashSync(req.body.newPassword, 10) },
    });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, all_lowercase: true }),
], validate, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email, is_active: 1 }).lean();
    // Always return success to prevent email enumeration
    if (!user) return res.json({ success: true, message: 'If that email exists, a reset OTP has been sent' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`🔑 Password reset OTP for ${user.email}: ${otp}`); // dev only

    // In production: send via nodemailer / SMS
    res.json({ success: true, message: 'Password reset OTP sent to your email', otp_dev: process.env.NODE_ENV === 'development' ? otp : undefined });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;