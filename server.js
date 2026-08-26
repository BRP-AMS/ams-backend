const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

// Prevent uncaught TF/WASM errors from killing the whole server
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Non-fatal — server stays up:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Non-fatal — server stays up:', reason);
});

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
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);

// ── CORS — must be FIRST, before helmet and everything else ───────────────
// Raw middleware so CORS headers are stamped on EVERY response (including
// error responses) before any other middleware can interfere.
const ALLOWED_ORIGINS = [
  'https://monitermark.brptripura.com',
  'https://monitormark.brptripura.com', 
  'https://mm-service.brptripura.com',
  process.env.FRONTEND_URL,
  process.env.BACKEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://103.44.0.48:3000',
  'http://erp.brptripura.com',
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    // same-origin or non-browser client — allow
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-register-secret');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24h preflight cache

  if (req.method === 'OPTIONS') {
    return res.status(204).end(); // short-circuit preflight here, always
  }
  next();
});

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

const isProd = process.env.NODE_ENV === 'production';
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
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize.sanitize(req.body, { replaceWith: '_' });
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = req.query[key].replace(/[$]/g, '');
      }
    }
  }
  next();
});

// 600 req/2min per IP — accommodates 90-user morning rush (~4 calls each = 360 req)
const limiter = rateLimit({
  windowMs:        2 * 60 * 1000,
  max:             600,
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

// ── Models ────────────────────────────────────────────────────────────────
const { connectionPromise, AttendanceRecord, User, Notification, RevokedToken, Holiday } = require('./src/models/database');
const { v4: uuidv4 } = require('uuid');
const { sendMail } = require('./src/utils/mailer');

// Shared by the reminder crons below — skip Sundays and configured holidays.
const isNonWorkingDayForReminders = async (dateIST) => {
  const dow = new Date(dateIST + 'T00:00:00+05:30').getDay();
  if (dow === 0) return true; // Sunday
  const holiday = await Holiday.findOne({ date: dateIST }).lean();
  return !!holiday;
};

// ─────────────────────────────────────────────────────────────────────────────
// CRON 1 — Midnight IST (00:05): Mark unchecked-out records as missed-checkout
//
// Finds any Draft attendance record from YESTERDAY or earlier that has a
// check-in but NO check-out, and converts it to:
//   status           = 'Pending'
//   is_missed_checkout = true
//
// This places it in the manager's queue so they can approve/reject it.
// The employee is BLOCKED from checking in again until the manager acts.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('5 0 * * *', async () => {
  console.log('[MissedCheckout Cron] Running at midnight IST...');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Find all Draft records from BEFORE today that have check-in but no check-out
    const unchecked = await AttendanceRecord.find({
      date:          { $lt: todayIST },   // strictly before today
      status:        'Draft',
      checkin_time:  { $ne: null },
      checkout_time: null,
    }).lean();

    console.log(`[MissedCheckout Cron] Found ${unchecked.length} unchecked-out record(s) to process.`);

    for (const record of unchecked) {
      // Mark as missed-checkout and move to Pending for manager review
      await AttendanceRecord.findByIdAndUpdate(record._id, {
        $set: {
          status:             'Pending',
          is_missed_checkout: true,
          checkout_remarks:   'Employee did not check out. Requires manager approval.',
          submitted_at:       new Date(),
        },
      });

      // Notify the employee
      await Notification.create({
        _id:               uuidv4(),
        user_id:           record.emp_id,
        title:             '⚠️ Missed Check-Out',
        message:           `You forgot to check out on ${record.date}. Your attendance has been sent to your manager for review. You cannot check in until they approve or reject it.`,
        type:              'warning',
        related_record_id: record._id,
        link:              '/employee/history',
      });

      // Notify the manager
      if (record.manager_id) {
        const emp = await User.findById(record.emp_id).select('name').lean();
        await Notification.create({
          _id:               uuidv4(),
          user_id:           record.manager_id,
          title:             '🔔 Missed Check-Out — Action Required',
          message:           `${emp?.name || 'An employee'} did not check out on ${record.date} (checked in at ${record.checkin_time}). Please review and approve or reject.`,
          type:              'warning',
          related_record_id: record._id,
          link:              '/manager/leaves',
        });
        const manager = await User.findById(record.manager_id).select('name email').lean();
        if (manager?.email) {
          sendMail(manager.email, '[AMS] Missed Check-Out — Action Required',
            `<p>Hi ${manager.name || 'there'},</p><p><strong>${emp?.name || 'An employee'}</strong> did not check out on ${record.date} (checked in at ${record.checkin_time}). They cannot check in again until you approve or reject this record.</p><p>Please review it in the Leaves queue.</p>`
          ).catch(err => console.error('[MissedCheckout Cron] Manager email failed:', err.message));
        }
      }

      await require('./src/models/database').AuditLog?.create?.({
        _id:         uuidv4(),
        user_id:     record.emp_id,
        action:      'MISSED_CHECKOUT_AUTO_FLAGGED',
        entity_type: 'attendance',
        entity_id:   record._id,
      }).catch(() => {}); // non-fatal
    }

    console.log(`[MissedCheckout Cron] Done — ${unchecked.length} record(s) flagged.`);
  } catch (err) {
    console.error('[MissedCheckout Cron] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON 2 — Fixed-time reminder (18:30, 19:30 … 23:30 IST): Remind employees
// to check out.
//
// Triggers purely on CLOCK TIME, not hours-since-checkin. Every employee who
// is still checked in (Draft, checkin set, no checkout) at/after 6:30pm gets
// notified — regardless of what time they checked in. Sends a notification
// reminder only — does NOT flag or block anyone. The midnight cron above
// handles the actual flagging.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('30 18-23 * * *', async () => {
  console.log('[MissedCheckout Reminder] Cron triggered');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const unchecked = await AttendanceRecord.find({
      date:          todayIST,
      status:        'Draft',
      checkin_time:  { $ne: null },
      checkout_time: null,
    }).lean();

    console.log(`[MissedCheckout Reminder] ${unchecked.length} employees still not checked out for ${todayIST}`);

    for (const record of unchecked) {
      // Throttle — don't spam more than once every 2 hours
      const recentNotif = await Notification.findOne({
        user_id:    record.emp_id,
        type:       'checkout_reminder',
        created_at: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      }).lean();

      if (recentNotif) continue;

      await Notification.create({
        _id:               uuidv4(),
        user_id:           record.emp_id,
        title:             '⏰ Please Check Out',
        message:           `You checked in at ${record.checkin_time} and haven't checked out yet. Check out before midnight to avoid a missed-checkout flag.`,
        type:              'checkout_reminder',
        related_record_id: record._id,
        link:              '/employee/attendance',
      });

      if (record.manager_id) {
        const emp = await User.findById(record.emp_id).select('name').lean();
        await Notification.create({
          _id:               uuidv4(),
          user_id:           record.manager_id,
          title:             '⚠️ Employee Not Checked Out',
          message:           `${emp?.name || 'An employee'} checked in at ${record.checkin_time} on ${record.date} and has not checked out yet.`,
          type:              'warning',
          related_record_id: record._id,
          link:              '/manager/leaves',
        });
      }
    }

    console.log('[MissedCheckout Reminder] Done');
  } catch (err) {
    console.error('[MissedCheckout Reminder] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON 3 — 9:00 AM IST: Email reminder to check in.
// Skips Sundays/holidays. Emails every active employee who hasn't checked in
// yet today and isn't on approved leave.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('[CheckIn Reminder Email] Cron triggered');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (await isNonWorkingDayForReminders(todayIST)) return console.log('[CheckIn Reminder Email] Skipped — non-working day');

    const employees = await User.find({ role: 'employee', is_active: { $ne: false } }).select('_id name email').lean();
    const [checkedIn, onLeave] = await Promise.all([
      AttendanceRecord.find({ date: todayIST, checkin_time: { $ne: null } }, 'emp_id').lean(),
      AttendanceRecord.find({
        duty_type: 'Leave', leave_status: 'Approved',
        date: { $lte: todayIST }, $or: [{ end_date: null }, { end_date: { $gte: todayIST } }],
      }, 'emp_id').lean(),
    ]);
    const skip = new Set([...checkedIn, ...onLeave].map(r => String(r.emp_id)));

    let sent = 0;
    for (const emp of employees) {
      if (skip.has(String(emp._id)) || !emp.email) continue;
      await sendMail(
        emp.email, '[AMS] Check-In Reminder',
        `<p>Hi ${emp.name},</p><p>Reminder to check in for today (${todayIST}).</p>`
      ).catch(err => console.error('[CheckIn Reminder Email] Send failed for', emp.email, err.message));
      sent++;
    }
    console.log(`[CheckIn Reminder Email] Sent ${sent} reminder(s).`);
  } catch (err) {
    console.error('[CheckIn Reminder Email] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON 4 — 7:00 PM IST: Email reminder to check out.
// Skips Sundays/holidays. Emails every employee still checked in (checkin
// set, no checkout) for today.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 19 * * *', async () => {
  console.log('[CheckOut Reminder Email] Cron triggered');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (await isNonWorkingDayForReminders(todayIST)) return console.log('[CheckOut Reminder Email] Skipped — non-working day');

    const unchecked = await AttendanceRecord.find({
      date: todayIST, status: 'Draft', checkin_time: { $ne: null }, checkout_time: null,
    }).lean();
    const empIds = unchecked.map(r => r.emp_id);
    const users  = await User.find({ _id: { $in: empIds } }).select('_id name email').lean();
    const emailById = new Map(users.map(u => [String(u._id), u]));

    let sent = 0;
    for (const record of unchecked) {
      const u = emailById.get(String(record.emp_id));
      if (!u?.email) continue;
      await sendMail(
        u.email, '[AMS] Check-Out Reminder',
        `<p>Hi ${u.name},</p><p>You checked in at ${record.checkin_time} on ${record.date} and haven't checked out yet. Please check out to avoid a missed check-out flag.</p>`
      ).catch(err => console.error('[CheckOut Reminder Email] Send failed for', u.email, err.message));
      sent++;
    }
    console.log(`[CheckOut Reminder Email] Sent ${sent} reminder(s).`);
  } catch (err) {
    console.error('[CheckOut Reminder Email] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: The old CRON 3 ("system auto check-out after 8 hours") has been
// removed on purpose. The system must never check an employee out for them.
//
// The employee ALWAYS checks out manually (with selfie + GPS + text address).
// If they miss it, CRON 1 (midnight) flags the record as a missed check-out
// and routes it to the manager queue. CRON 2 (6:30pm–11:30pm) nudges anyone
// still checked in. When the employee eventually taps "Check Out" on a
// missed-checkout record, the route in attendance.js (PUT /:id/checkout,
// `record.is_missed_checkout` branch) auto-approves it if 8+ hours had
// elapsed since check-in, otherwise it stays Pending for one manager
// approve/reject decision. That logic already lived in attendance.js and
// is untouched — this cron was the only thing fighting it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Revoked-token pruning ─────────────────────────────────────────────────
const pruneRevokedTokens = async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await RevokedToken.deleteMany({ revoked_at: { $lt: cutoff } });
  } catch (err) {
    console.error('Token prune error:', err.message);
  }
};

connectionPromise.then(async () => {
  pruneRevokedTokens();
  setInterval(pruneRevokedTokens, 60 * 60 * 1000);
  require('./src/utils/mailer');
});

// ── Routes ────────────────────────────────────────────────────────────────
const attendanceRouter = require('./src/routes/attendance');
app.use('/api/auth',              require('./src/routes/auth'));
app.use('/api/attendance',        attendanceRouter);
app.use('/api/users',             require('./src/routes/users'));
app.use('/api/reports',           require('./src/routes/reports'));
app.use('/api/notifications',     require('./src/routes/notifications'));
app.use('/api/activity',          require('./src/routes/activity'));
app.use('/api/activity-schedule', require('./src/routes/activity-schedule'));
app.use('/api/msme',              require('./src/routes/msme'));
app.use('/api/custom-options',    require('./src/routes/custom-options'));
app.use('/api/blocks',            require('./src/routes/blocks'));
app.use('/api/departments',       require('./src/routes/departments'));
app.use('/api/monthly-report',    require('./src/routes/monthlyReport'));
app.use('/api/oda',               require('./src/routes/oda'));
app.use('/api/geocode',           require('./src/routes/geocode'));
app.use('/api/file',              require('./src/routes/file'));
app.use('/api/holidays',          require('./src/routes/holidays'));
app.use('/api/dept-dashboard',    require('./src/routes/dept-dashboard'));

// Health check — version bump triggers Render redeploy detection
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.2.0',
    msmeUnfiltered: true,  // confirms MSME route no longer filters by block for employees
  });
});


// ── Temporary email debug endpoint ────────────────────────────────────────
app.post('/api/admin/test-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  const results = {};

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

const server = app.listen(PORT, () => {
  console.log(`\n🚀 BRP Attendance API running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`\nRun 'npm run seed' to populate demo data\n`);
});

// Graceful shutdown — Render sends SIGTERM before killing the container.
// Stop accepting new connections and let in-flight requests finish (max 15s).
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Graceful shutdown starting…');
  server.close(() => {
    console.log('[SIGTERM] All connections closed — exiting');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[SIGTERM] Forced exit after 15s timeout');
    process.exit(1);
  }, 15000);
});

module.exports = app;