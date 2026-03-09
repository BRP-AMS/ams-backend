const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
// require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const rateLimit = require('express-rate-limit');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security & Middleware ─────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
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
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting — scaled for up to 200 concurrent users
// 200 users × ~10 req/min × 2-min window = ~4,000 req; max:10000 gives 2.5× headroom
const limiter     = rateLimit({ windowMs: 2 * 60 * 1000, max: 10000, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500,  message: { success: false, message: 'Too many login attempts, please try again later.' } });
app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);

// Static file serving for uploads
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(path.resolve(uploadDir)));

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
