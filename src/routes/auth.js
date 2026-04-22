const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
const { User, AuditLog, RevokedToken } = require('../models/database');
const { authenticate } = require('../middleware/auth');

// ── Email helper ──────────────────────────────────────────────────────────
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

const sendMail = async (to, subject, html) => {
  if (!mailer) {
    console.warn('[Auth] SMTP not configured — skipping email to:', to);
    return;
  }
  try {
    await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
  } catch (err) {
    console.error('[Auth] Email send error:', err.message);
  }
};

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, emp_id: user.emp_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    // Audit log
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'LOGIN', ip_address: req.ip });

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
        id:            user._id,
        empId:         user.emp_id,
        name:          user.name,
        email:         user.email,
        role:          user.role,
        department:    user.department,
        managerId:     user.manager_id,
        managerName,
        managerEmail,
        phone:         user.phone,
        assignedBlock:    user.assigned_block,
        assignedDistrict: user.assigned_district,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Shared in-memory reset tokens (also used by users.js admin flow)
const resetTokens = require('../utils/resetTokens');

// POST /api/auth/forgot-password
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Valid email required.' });

  try {
    const { email } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with that email.' });
    }

    const token = crypto.randomBytes(20).toString('hex');
    await resetTokens.set(token, user._id, 15 * 60 * 1000); // 15 min

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink   = `${frontendUrl}/reset-password?token=${token}`;

    await sendMail(
      user.email,
      'BRP AMS — Password Reset Request',
      `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8fafc;border-radius:12px;">
        <div style="text-align:center;margin-bottom:28px;">
          <h2 style="color:#1E3A8A;margin:0 0 6px;">BRP Attendance System</h2>
          <p style="color:#64748b;font-size:14px;margin:0;">Password Reset Request</p>
        </div>
        <div style="background:#fff;border-radius:10px;padding:28px;border:1px solid #e2e8f0;">
          <p style="color:#0f172a;font-size:15px;margin:0 0 16px;">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px;">
            We received a request to reset your password. Click the button below to set a new password.
            This link is valid for <strong>15 minutes</strong>.
          </p>
          <div style="text-align:center;margin-bottom:24px;">
            <a href="${resetLink}"
               style="display:inline-block;background:#1E3A8A;color:#fff;text-decoration:none;
                      padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;
                      letter-spacing:0.3px;">
              Reset My Password
            </a>
          </div>
          <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${resetLink}" style="color:#2563EB;word-break:break-all;">${resetLink}</a>
          </p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;"/>
          <p style="color:#94a3b8;font-size:12px;margin:0;">
            If you didn't request a password reset, you can safely ignore this email.
            Your password will not change.
          </p>
        </div>
        <p style="text-align:center;color:#cbd5e1;font-size:11px;margin-top:20px;">
          © ${new Date().getFullYear()} BRP · All rights reserved
        </p>
      </div>
      `
    );

    const response = { success: true, message: mailer ? 'Password reset link sent to your email.' : 'SMTP not configured — use the reset code below.' };
    if (!mailer) response.resetToken = token;
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', [
  body('token').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Token and password (min 6 chars) required.' });

  try {
    const { token, newPassword } = req.body;
    const record = await resetTokens.get(token);

    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
    }

    await User.findByIdAndUpdate(record.userId, {
      $set: { password_hash: bcrypt.hashSync(newPassword, 10) }
    });
    await resetTokens.delete(token);

    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.token).digest('hex');
    // token_hash is stored as _id; upsert avoids duplicate-key errors
    await RevokedToken.updateOne({ _id: tokenHash }, { $setOnInsert: { _id: tokenHash, revoked_at: new Date() } }, { upsert: true });
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'LOGOUT', ip_address: req.ip });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.aggregate([
      { $match: { _id: req.user.id } },
      { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
      { $addFields: {
          manager_name:  { $arrayElemAt: ['$manager.name',  0] },
          manager_email: { $arrayElemAt: ['$manager.email', 0] },
          manager_phone: { $arrayElemAt: ['$manager.phone', 0] },
      }},
      { $project: { manager: 0, password_hash: 0 } },
    ]);

    if (!user.length) return res.status(404).json({ success: false, message: 'User not found' });
    const u = user[0];

    res.json({ success: true, user: {
      id:            u._id,
      empId:         u.emp_id,
      name:          u.name,
      email:         u.email,
      role:          u.role,
      department:    u.department,
      managerId:     u.manager_id,
      managerName:   u.manager_name,
      managerEmail:  u.manager_email,
      managerPhone:  u.manager_phone,
      phone:         u.phone,
      createdAt:     u.created_at,
      assignedBlock:    u.assigned_block,
      assignedDistrict: u.assigned_district,
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).lean();

    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    await User.findByIdAndUpdate(req.user.id, {
      $set: { password_hash: bcrypt.hashSync(newPassword, 10) }
    });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
