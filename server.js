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
  null,                      // allow requests with no origin (mobile apps)
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
  next();
});

// Global rate limit (prevents DDoS / scraping)
const limiter = rateLimit({ windowMs: 2 * 60 * 1000, max: 5000, standardHeaders: true, legacyHeaders: false });
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

// ── Seed endpoint (temporary — run once then remove) ─────────────────────
app.get('/api/run-seed', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const { User, AttendanceRecord, Notification, AuditLog } = require('./src/models/database');

    // Clear existing data
    await Promise.all([
      AuditLog.deleteMany({}),
      Notification.deleteMany({}),
      AttendanceRecord.deleteMany({}),
      User.deleteMany({}),
    ]);

    const hash = (pw) => bcrypt.hashSync(pw, 10);
    const pw = 'R@m%Brp@26';

    await User.insertMany([
      { _id: uuidv4(), emp_id: 'SADM001', name: 'Super Admin', email: 'ajay.s@raminfo.com', password_hash: hash(pw), role: 'super_admin', department: 'Administration', manager_id: null, phone: '9000000001', email_verified: true },
      { _id: uuidv4(), emp_id: 'ADM001', name: 'Admin User', email: 'ajay.rges@gmal.com', password_hash: hash(pw), role: 'admin', department: 'Administration', manager_id: null, phone: '9000000002', email_verified: true },
    ]);

    res.json({ success: true, message: 'Database seeded! Login: ajay.s@raminfo.com / R@m%Brp@26' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: unlock all locked accounts (temporary) ───────────────────────
app.get('/api/admin-unlock', async (req, res) => {
  try {
    const { User } = require('./src/models/database');
    const result = await User.updateMany(
      {},
      { $set: { login_locked_until: null, failed_login_attempts: 0 } }
    );
    res.json({ success: true, unlocked: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Email test endpoint (temporary — remove after debugging) ─────────────
app.get('/api/test-email', async (req, res) => {
  const { sendMail, mode } = require('./src/utils/mailer');
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Pass ?to=email@example.com' });
  try {
    const info = await sendMail(to, '[BRP AMS] Test Email',
      '<h2>✅ Email is working!</h2><p>This is a test email from BRP-AMS backend on Render.</p>',
      { type: 'PASSWORD_RESET' }
    );
    res.json({ success: true, mode, info: info || 'sent' });
  } catch (err) {
    res.status(500).json({ success: false, mode, error: err.message, code: err.code });
  }
});

// ── Error Handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 BRP Attendance API running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`\nRun 'npm run seed' to populate demo data\n`);
});

module.exports = app;
