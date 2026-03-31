const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit  = require('express-rate-limit');
const { User, AuditLog, RevokedToken } = require('../models/database');
const { authenticate } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../utils/firebaseMailer');

// ── Rate limiters ─────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many password reset requests. Try again in 1 hour.' },
});

const validate = (req, res, next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ success: false, message: e.array()[0].msg });
  next();
};

// ── Firebase Auth helper (verify password against Firebase) ─────────────────
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const verifyWithFirebase = async (email, password) => {
  if (!FIREBASE_API_KEY) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const data = await res.json();
    return res.ok && !!data.idToken;
  } catch { return false; }
};

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/login
// ══════════════════════════════════════════════════════════════════════════════
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }),
  body('password').notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    if (user && user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
      return res.status(423).json({ success: false, message: 'Account temporarily locked. Try again later.' });
    }

    let passwordValid = user && bcrypt.compareSync(password, user.password_hash);

    // If MongoDB password fails, try Firebase (user may have reset via Firebase)
    if (!passwordValid && user && FIREBASE_API_KEY) {
      const firebaseOk = await verifyWithFirebase(email, password);
      if (firebaseOk) {
        console.log(`[Auth] Firebase password sync for: ${email}`);
        const syncUpdate = { password_hash: bcrypt.hashSync(password, 12) };
        if (!user.email_verified) {
          syncUpdate.email_verified = true;
          console.log(`[Auth] Auto-verified email for: ${email}`);
        }
        await User.findByIdAndUpdate(user._id, { $set: syncUpdate });
        passwordValid = true;
      }
    }

    if (!user || !passwordValid) {
      if (user) {
        await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'LOGIN_FAILED', ip_address: req.ip });
        const attempts = (user.failed_login_attempts || 0) + 1;
        const updateFields = { failed_login_attempts: attempts };
        if (attempts >= 5) updateFields.login_locked_until = new Date(Date.now() + 15 * 60 * 1000);
        await User.findByIdAndUpdate(user._id, { $set: updateFields });
      }
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    await User.findByIdAndUpdate(user._id, { $set: { failed_login_attempts: 0, login_locked_until: null } });

    const token = jwt.sign(
      { id: user._id, role: user.role, emp_id: user.emp_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'LOGIN', ip_address: req.ip });

    let managerName = null, managerEmail = null;
    if (user.manager_id) {
      const mgr = await User.findById(user.manager_id).select('name email').lean();
      if (mgr) { managerName = mgr.name; managerEmail = mgr.email; }
    }

    res.json({
      success: true, token,
      user: {
        id:               user._id,
        empId:            user.emp_id,
        name:             user.name,
        email:            user.email,
        role:             user.role,
        department:       user.department,
        managerId:        user.manager_id,
        managerName,      managerEmail,
        phone:            user.phone,
        emailVerified:    user.email_verified   || false,
        phoneVerified:    user.phone_verified   || false,
        assignedBlock:    user.assigned_block,
        assignedDistrict: user.assigned_district,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/logout
// ══════════════════════════════════════════════════════════════════════════════
router.post('/logout', authenticate, async (req, res) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.token).digest('hex');
    await RevokedToken.updateOne(
      { _id: tokenHash },
      { $setOnInsert: { _id: tokenHash, revoked_at: new Date() } },
      { upsert: true }
    );
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'LOGOUT', ip_address: req.ip });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/auth/me
// ══════════════════════════════════════════════════════════════════════════════
router.get('/me', authenticate, async (req, res) => {
  try {
    const users = await User.aggregate([
      { $match: { _id: req.user.id } },
      { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
      { $addFields: {
          manager_name:  { $arrayElemAt: ['$manager.name',  0] },
          manager_email: { $arrayElemAt: ['$manager.email', 0] },
          manager_phone: { $arrayElemAt: ['$manager.phone', 0] },
      }},
      { $project: { manager: 0, password_hash: 0, email_verify_token: 0, pwd_reset_token: 0, phone_otp: 0 } },
    ]);

    if (!users.length) return res.status(404).json({ success: false, message: 'User not found' });
    const u = users[0];
    res.json({ success: true, user: {
      id:               u._id,
      empId:            u.emp_id,
      name:             u.name,
      email:            u.email,
      role:             u.role,
      department:       u.department,
      managerId:        u.manager_id,
      managerName:      u.manager_name,
      managerEmail:     u.manager_email,
      managerPhone:     u.manager_phone,
      phone:            u.phone,
      emailVerified:    u.email_verified   || false,
      phoneVerified:    u.phone_verified   || false,
      createdAt:        u.created_at,
      assignedBlock:    u.assigned_block,
      assignedDistrict: u.assigned_district,
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PUT /api/auth/change-password
// ══════════════════════════════════════════════════════════════════════════════
router.put('/change-password', authenticate, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Must contain at least one special character'),
], validate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).lean();

    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    if (bcrypt.compareSync(newPassword, user.password_hash))
      return res.status(400).json({ success: false, message: 'New password must differ from current password' });

    await User.findByIdAndUpdate(req.user.id, {
      $set: { password_hash: bcrypt.hashSync(newPassword, 12), pwd_changed_at: new Date() }
    });
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHANGE_PASSWORD', ip_address: req.ip });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/forgot-password  —  Firebase only
// ══════════════════════════════════════════════════════════════════════════════
router.post('/forgot-password', forgotLimiter, [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }).withMessage('Valid email required'),
], validate, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    const OK = { success: true, message: 'If that email is registered you will receive a password reset email shortly.' };
    if (!user) return res.json(OK);

    await sendPasswordResetEmail(user.email);
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'FORGOT_PASSWORD', ip_address: req.ip });
    res.json(OK);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
