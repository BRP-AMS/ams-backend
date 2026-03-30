const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
// require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is required');
  process.exit(1);
}

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const cron          = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 5000;

// Render (and most hosts) use a reverse proxy — trust it for rate-limiting & IP detection
app.set('trust proxy', 1);

// ── Security & Middleware ─────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
  frameguard: { action: 'deny' },
}));
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:3000',   // local dev
  'http://localhost:3001',   // local dev fallback
  'capacitor://localhost',   // Android Capacitor app
  'http://localhost',        // Android WebView fallback
  'https://localhost',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Sanitize req.body against NoSQL injection ($, .)
// Note: In Express 5, req.query and req.params are read-only (getter/Proxy).
// Reassigning them breaks internal route matching. URL path params and query
// strings don't need NoSQL sanitization — only user-supplied JSON bodies do.
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize.sanitize(req.body, { replaceWith: '_' });
  // Sanitize query params: strip any keys containing $ or . to prevent NoSQL injection
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = req.query[key].replace(/[$]/g, '');
      }
    }
  }
  next();
});

// Global rate limit (prevents DDoS / scraping)
const limiter = rateLimit({ windowMs: 2 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ── Auto-checkout cron (23:58 every day) ─────────────────────────────────
// Finds all Draft records (checked-in but not checked-out) for today and
// auto-checks them out with a remark, then notifies each employee's manager.
const { connectionPromise, AttendanceRecord, User, Notification, RevokedToken } = require('./src/models/database');
const { v4: uuidv4 } = require('uuid');

cron.schedule('58 23 * * *', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const unchecked = await AttendanceRecord.find({ date: today, status: 'Draft', checkout_time: null }).lean();
    console.log(`[AutoCheckout] ${unchecked.length} unchecked records for ${today}`);
    for (const record of unchecked) {
      await AttendanceRecord.findByIdAndUpdate(record._id, {
        $set: {
          checkout_time:     '23:59',
          status:            'Pending',
          submitted_at:      new Date(),
          is_auto_checkout:  true,
          checkout_remarks:  'Auto checkout – employee did not check out before end of day',
          worked_hours:      null,
        }
      });
      if (record.manager_id) {
        const emp = await User.findById(record.emp_id).select('name').lean();
        await Notification.create({
          _id:               uuidv4(),
          user_id:           record.manager_id,
          title:             '⚠️ Auto Checkout Alert',
          message:           `${emp?.name || 'An employee'} forgot to check out on ${record.date}. Auto-checked out at 23:59. Review and approve/reject with valid proof.`,
          type:              'warning',
          related_record_id: record._id,
        });
      }
    }
  } catch (err) {
    console.error('[AutoCheckout] Error:', err.message);
  }
});

// ── Revoked-token pruning ─────────────────────────────────────────────────
// JWTs expire after 24 h, so any token revoked more than 24 h ago is safe to
// delete — the original token would be rejected by jwt.verify() anyway.

const pruneRevokedTokens = async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await RevokedToken.deleteMany({ revoked_at: { $lt: cutoff } });
  } catch (err) {
    console.error('Token prune error:', err.message);
  }
};

// Run once at startup (after DB connection), then hourly
connectionPromise.then(() => {
  pruneRevokedTokens();
  setInterval(pruneRevokedTokens, 60 * 60 * 1000);

  // SMTP verification happens automatically in src/utils/mailer.js on require()
  require('./src/utils/mailer');
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',         require('./src/routes/auth'));
app.use('/api/attendance',   require('./src/routes/attendance'));
app.use('/api/users',        require('./src/routes/users'));
app.use('/api/reports',      require('./src/routes/reports'));
app.use('/api/notifications',require('./src/routes/notifications'));
app.use('/api/activity',          require('./src/routes/activity'));
app.use('/api/activity-schedule', require('./src/routes/activity-schedule'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ── Temporary seed endpoint (remove after use) ───────────────────────────
app.post('/api/admin/seed', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const validator = require('validator');
    const { User } = require('./src/models/database');
    const hash = (pw) => bcrypt.hashSync(pw, 10);
    const pw = 'R@m%Brp@26';
    // normalizeEmail strips dots from Gmail — login does the same
    const norm = (e) => validator.normalizeEmail(e);

    const mgr1Id = uuidv4();
    const mgr2Id = uuidv4();

    const users = [
      { emp_id: 'SADM001', name: 'Super Admin', email: norm('ajay.s@raminfo.com'), role: 'super_admin', department: 'Administration', manager_id: null, phone: '9000000001', assigned_block: null, assigned_district: null },
      { emp_id: 'ADM001',  name: 'Admin User',  email: norm('ajay.rges@gmail.com'), role: 'admin', department: 'Administration', manager_id: null, phone: '9000000002', assigned_block: null, assigned_district: null },
      { emp_id: 'HR001',   name: 'HR Manager',  email: norm('hr.brpams@gmail.com'), role: 'hr', department: 'Human Resources', manager_id: null, phone: '9000000003', assigned_block: null, assigned_district: null },
      { emp_id: 'MGR001',  name: 'Rajesh Kumar',  email: norm('mgr1.brpams@gmail.com'), role: 'manager', department: 'Field Operations', manager_id: null, phone: '9000000004', assigned_block: 'Agartala', assigned_district: 'West Tripura', _forceId: mgr1Id },
      { emp_id: 'MGR002',  name: 'Priya Sharma',  email: norm('mgr2.brpams@gmail.com'), role: 'manager', department: 'Marketing', manager_id: null, phone: '9000000005', assigned_block: 'Udaipur', assigned_district: 'South Tripura', _forceId: mgr2Id },
      { emp_id: 'EMP001',  name: 'Amit Das',      email: norm('emp1.brpams@gmail.com'), role: 'employee', department: 'Field Operations', manager_id: mgr1Id, phone: '9000000006', assigned_block: 'Agartala', assigned_district: 'West Tripura' },
      { emp_id: 'EMP002',  name: 'Suman Deb',     email: norm('emp2.brpams@gmail.com'), role: 'employee', department: 'Field Operations', manager_id: mgr1Id, phone: '9000000007', assigned_block: 'Block A', assigned_district: 'West Tripura' },
      { emp_id: 'EMP003',  name: 'Ritu Nath',     email: norm('emp3.brpams@gmail.com'), role: 'employee', department: 'Marketing', manager_id: mgr2Id, phone: '9000000008', assigned_block: 'Udaipur', assigned_district: 'South Tripura' },
      { emp_id: 'EMP004',  name: 'Bikram Reang',  email: norm('emp4.brpams@gmail.com'), role: 'employee', department: 'Marketing', manager_id: mgr2Id, phone: '9000000009', assigned_block: 'District 1', assigned_district: 'South Tripura' },
    ];

    const results = [];
    for (const u of users) {
      const existing = await User.findOne({ emp_id: u.emp_id });
      const forceId = u._forceId; delete u._forceId;
      if (existing) {
        // Reset password for existing users too
        await User.findByIdAndUpdate(existing._id, { $set: { ...u, is_active: 1, email_verified: true, password_hash: hash(pw) } });
        if (forceId) {
          results.push({ emp_id: u.emp_id, email: u.email, action: 'updated+pwd_reset', _id: existing._id });
          users.forEach(eu => { if (eu.manager_id === forceId) eu.manager_id = existing._id; });
        } else {
          results.push({ emp_id: u.emp_id, email: u.email, action: 'updated+pwd_reset', _id: existing._id });
        }
      } else {
        const newId = forceId || uuidv4();
        await User.create({ _id: newId, ...u, password_hash: hash(pw), is_active: 1, email_verified: true });
        results.push({ emp_id: u.emp_id, email: u.email, action: 'created', _id: newId });
      }
    }

    res.json({ success: true, message: 'Seed complete', data: results, password: pw });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Temporary email debug endpoint (remove after testing) ─────────────────
app.post('/api/admin/test-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  const results = {};

  // Test 1: Firebase password reset
  try {
    const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
    if (FIREBASE_API_KEY) {
      const fbRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
      });
      const fbData = await fbRes.json();
      results.firebase = { status: fbRes.status, ok: fbRes.ok, data: fbData };
    } else {
      results.firebase = { status: 'skipped', reason: 'no FIREBASE_API_KEY' };
    }
  } catch (err) {
    results.firebase = { error: err.message };
  }

  // Test 2: SMTP
  try {
    const { sendMail, mode } = require('./src/utils/mailer');
    results.mailer_mode = mode;
    await sendMail(email, '[BRP AMS] Email Test', '<h2>BRP-AMS Email Test</h2><p>This confirms email delivery is working. Time: ' + new Date().toISOString() + '</p>');
    results.smtp = { status: 'sent' };
  } catch (err) {
    results.smtp = { error: err.message };
  }

  res.json({ success: true, results });
});

// ── Error Handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(err.status || 500).json({ success: false, message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 BRP Attendance API running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`\nRun 'npm run seed' to populate demo data\n`);
});

module.exports = app;
