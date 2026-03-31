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
const { sendMail } = require('../utils/mailer');

// ── Helpers ───────────────────────────────────────────────────────────────
const generateToken = () => crypto.randomBytes(32).toString('hex');
const hashToken     = (t) => crypto.createHash('sha256').update(t).digest('hex');

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

// ── Branded email layout ──────────────────────────────────────────────────
const emailLayout = (title, bodyHtml) => `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP &middot; AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">${title}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">
    Do not reply to this email &middot; BRP AMS Automated System
  </p>
</td></tr>
</table>
</td></tr></table></body></html>`;

// ── Firebase Auth helper (for password sync on login) ───────────────────
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

// ── POST /api/auth/login ──────────────────────────────────────────────────
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }),
  body('password').notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    // Account lockout check
    if (user && user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
      return res.status(423).json({ success: false, message: 'Account temporarily locked. Try again later.' });
    }

    let passwordValid = user && bcrypt.compareSync(password, user.password_hash);

    // If MongoDB password fails, try Firebase Auth (user may have reset password via Firebase)
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
        if (attempts >= 5) {
          updateFields.login_locked_until = new Date(Date.now() + 15 * 60 * 1000);
        }
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

// ── POST /api/auth/logout ─────────────────────────────────────────────────
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

// ── GET /api/auth/me ──────────────────────────────────────────────────────
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

// ── PUT /api/auth/change-password ─────────────────────────────────────────
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

// ── POST /api/auth/forgot-password ───────────────────────────────────────
// Generates reset token, sends email via Gmail relay (which works), link goes
// to backend-hosted reset page. No Firebase email needed.
router.post('/forgot-password', forgotLimiter, [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }).withMessage('Valid email required'),
], validate, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email, is_active: 1 }).lean();

    const OK = { success: true, message: 'If that email is registered you will receive a password reset email shortly.' };
    if (!user) return res.json(OK);

    const rawToken  = generateToken();
    const hashedTok = hashToken(rawToken);
    const expires   = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await User.findByIdAndUpdate(user._id, {
      $set: { pwd_reset_token: hashedTok, pwd_reset_expires: expires }
    });

    const BACKEND = process.env.BACKEND_URL || 'https://ams-backend-1-yvgm.onrender.com';
    const resetUrl = `${BACKEND}/api/auth/reset-password-page?token=${rawToken}`;

    await sendMail(user.email, '[BRP AMS] Reset Your Password',
      emailLayout('Reset Your Password', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, we received a request to reset your password.
        </p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${resetUrl}"
            style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
                   text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color:#94a3b8;font-size:12px;">This link expires in 30 minutes. If you did not request this, ignore this email.</p>
      `)
    );

    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'FORGOT_PASSWORD', ip_address: req.ip });
    res.json(OK);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/auth/reset-password-page ────────────────────────────────────
// Backend-hosted password reset form. User clicks link in email → sees this page.
router.get('/reset-password-page', async (req, res) => {
  const { token } = req.query;
  const FRONTEND = process.env.FRONTEND_URL || 'https://ams-frontend-web-niuz.onrender.com';

  if (!token) {
    return res.status(400).send(errorPage('Invalid Link', 'No reset token provided.', FRONTEND));
  }

  const hashedTok = hashToken(token);
  const user = await User.findOne({
    pwd_reset_token:   hashedTok,
    pwd_reset_expires: { $gt: new Date() },
  }).lean();

  if (!user) {
    return res.status(400).send(errorPage('Link Expired', 'This reset link is invalid or has expired. Please request a new one.', FRONTEND));
  }

  // Serve the reset form
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset Password - BRP AMS</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f2f6f8;font-family:Arial,sans-serif;padding:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);
        padding:40px 36px;max-width:440px;width:100%;text-align:center}
  h1{color:#0b1e3b;font-size:22px;margin-bottom:8px}
  .sub{color:#64748b;font-size:14px;margin-bottom:28px}
  label{display:block;text-align:left;color:#334155;font-size:13px;font-weight:600;margin-bottom:6px}
  input{width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;
        font-size:15px;margin-bottom:16px;transition:border .2s}
  input:focus{outline:none;border-color:#21879d}
  .btn{width:100%;padding:14px;background:#0b1e3b;color:#fff;border:none;border-radius:10px;
       font-size:16px;font-weight:700;cursor:pointer;transition:background .2s}
  .btn:hover{background:#1e3a5f}
  .btn:disabled{background:#94a3b8;cursor:not-allowed}
  .error{color:#dc2626;font-size:13px;margin-bottom:12px;display:none}
  .success{color:#16a34a;font-size:14px;margin:16px 0}
  .rules{text-align:left;color:#64748b;font-size:12px;margin-bottom:20px;padding-left:16px}
  .rules li{margin-bottom:4px}
  .brand{color:#0b1e3b;font-size:12px;margin-top:24px;opacity:.5}
</style></head>
<body>
<div class="card">
  <h1>Reset Password</h1>
  <p class="sub">Hi <strong>${user.name}</strong>, set your new password below.</p>
  <form id="resetForm">
    <input type="hidden" name="token" value="${token}">
    <label for="pw">New Password</label>
    <input type="password" id="pw" name="newPassword" placeholder="Enter new password" required minlength="8">
    <label for="pw2">Confirm Password</label>
    <input type="password" id="pw2" placeholder="Confirm new password" required>
    <ul class="rules">
      <li>At least 8 characters</li>
      <li>At least one uppercase letter (A-Z)</li>
      <li>At least one number (0-9)</li>
      <li>At least one special character (!@#$%...)</li>
    </ul>
    <div class="error" id="err"></div>
    <button type="submit" class="btn" id="submitBtn">Reset Password</button>
  </form>
  <div id="successMsg" style="display:none">
    <div class="success">Password reset successfully!</div>
    <a href="${FRONTEND}/login" class="btn" style="display:inline-block;text-decoration:none;margin-top:12px;padding:13px 32px;">Go to Login</a>
  </div>
  <div class="brand">BRP &middot; AMS | Attendance Management System</div>
</div>
<script>
document.getElementById('resetForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const err = document.getElementById('err');
  const pw = document.getElementById('pw').value;
  const pw2 = document.getElementById('pw2').value;
  err.style.display = 'none';

  if (pw !== pw2) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
  if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters'; err.style.display = 'block'; return; }
  if (!/[A-Z]/.test(pw)) { err.textContent = 'Must contain an uppercase letter'; err.style.display = 'block'; return; }
  if (!/[0-9]/.test(pw)) { err.textContent = 'Must contain a number'; err.style.display = 'block'; return; }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(pw)) { err.textContent = 'Must contain a special character'; err.style.display = 'block'; return; }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Resetting...';

  try {
    const res = await fetch(window.location.origin + '/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '${token}', newPassword: pw })
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(_) { data = { success: false, message: 'Bad response: ' + text.substring(0, 100) }; }
    if (data.success) {
      document.getElementById('resetForm').style.display = 'none';
      document.getElementById('successMsg').style.display = 'block';
      alert('SUCCESS! Password has been reset. You can now login with your new password.');
    } else {
      err.textContent = (data.message || 'Reset failed') + ' (HTTP ' + res.status + ')';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Reset Password';
      alert('ERROR: ' + (data.message || 'Reset failed') + ' (HTTP ' + res.status + ')');
    }
  } catch(e) {
    err.textContent = 'Network error: ' + e.message;
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Reset Password';
    alert('NETWORK ERROR: ' + e.message);
  }
});
</script>
</body></html>`);
});

// ── POST /api/auth/reset-password ────────────────────────────────────────
// Called by the reset form above
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Must contain at least one special character'),
], validate, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const hashedTok = hashToken(token);

    const user = await User.findOne({
      pwd_reset_token:   hashedTok,
      pwd_reset_expires: { $gt: new Date() },
    }).lean();

    if (!user)
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired.' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_hash:     bcrypt.hashSync(newPassword, 12),
        pwd_reset_token:   null,
        pwd_reset_expires: null,
        pwd_changed_at:    new Date(),
        is_active:         1,
      }
    });
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'RESET_PASSWORD', ip_address: req.ip });

    // Also update Firebase Auth shadow user so login sync stays in sync
    if (FIREBASE_API_KEY) {
      try {
        const { ensureFirebaseUser } = require('../utils/firebaseMailer');
        await ensureFirebaseUser(user.email, newPassword);
        console.log(`[Auth] Firebase shadow user updated for: ${user.email}`);
      } catch (e) {
        console.error('[Auth] Firebase sync failed (non-critical):', e.message);
      }
    }

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/auth/test-reset-flow — TEMPORARY DEBUG (remove after testing) ──
// Tests the full password reset flow end-to-end on the server itself
router.get('/test-reset-flow', async (req, res) => {
  const testEmail = req.query.email;
  if (!testEmail) return res.json({ error: 'Pass ?email=xxx' });

  const results = {};
  try {
    // Step 1: Find user
    const user = await User.findOne({ email: testEmail }).lean();
    if (!user) return res.json({ error: 'User not found', email: testEmail });
    results.step1_user = { id: user._id, email: user.email, is_active: user.is_active, has_pwd_hash: !!user.password_hash };

    // Step 2: Create a reset token (same as forgot-password does)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedTok = hashToken(rawToken);
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    await User.findByIdAndUpdate(user._id, { $set: { pwd_reset_token: hashedTok, pwd_reset_expires: expires } });
    results.step2_token_saved = true;

    // Step 3: Verify token can be found (same as reset-password POST does)
    const found = await User.findOne({ pwd_reset_token: hashedTok, pwd_reset_expires: { $gt: new Date() } }).lean();
    results.step3_token_found = !!found;

    // Step 4: Hash new password and save (same as reset-password POST does)
    const newPwd = 'TestReset@999';
    const newHash = bcrypt.hashSync(newPwd, 12);
    await User.findByIdAndUpdate(user._id, {
      $set: { password_hash: newHash, pwd_reset_token: null, pwd_reset_expires: null, pwd_changed_at: new Date(), is_active: 1 }
    });
    results.step4_password_saved = true;

    // Step 5: Read back and verify
    const after = await User.findOne({ email: testEmail }).lean();
    results.step5_new_pwd_matches = bcrypt.compareSync(newPwd, after.password_hash);
    results.step5_old_pwd_matches = bcrypt.compareSync('Pass@123', after.password_hash);
    results.step5_token_cleared = after.pwd_reset_token === null;

    // Step 6: Restore original password
    await User.findByIdAndUpdate(user._id, {
      $set: { password_hash: bcrypt.hashSync('Pass@123', 12), pwd_reset_token: null, pwd_reset_expires: null }
    });
    results.step6_restored = true;

    res.json({ success: true, results });
  } catch (err) {
    res.json({ success: false, error: err.message, stack: err.stack, results });
  }
});

// ── Helper: error page HTML ──────────────────────────────────────────────
function errorPage(title, message, frontendUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - BRP AMS</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f2f6f8;font-family:Arial,sans-serif;padding:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);
        padding:40px 36px;max-width:440px;width:100%;text-align:center}
  h1{color:#0b1e3b;font-size:22px;margin-bottom:12px}
  p{color:#475569;font-size:14px;line-height:1.7;margin-bottom:28px}
  a.btn{display:inline-block;background:#64748b;color:#fff;
        padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}
  .brand{color:#0b1e3b;font-size:12px;margin-top:24px;opacity:.5}
</style></head>
<body><div class="card">
  <div style="font-size:52px;margin-bottom:20px">&#10060;</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a class="btn" href="${frontendUrl}/login">Go to Login</a>
  <div class="brand">BRP &middot; AMS | Attendance Management System</div>
</div></body></html>`;
}

module.exports = router;
