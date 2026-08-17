const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
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
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);

// ── CORS — must be FIRST, before helmet and everything else ───────────────
// Raw middleware so CORS headers are stamped on EVERY response (including
// error responses) before any other middleware can interfere.
const ALLOWED_ORIGINS = [
  'https://monitermark.brptripura.com',
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
    const sanitizeValue = (v) => {
      if (typeof v === 'string') return v.replace(/[$]/g, '');
      if (typeof v === 'object' && v !== null) {
        // Reject object-type params entirely — they carry NoSQL operator payloads
        return undefined;
      }
      return v;
    };
    for (const key of Object.keys(req.query)) {
      const sanitized = sanitizeValue(req.query[key]);
      if (sanitized === undefined) delete req.query[key];
      else req.query[key] = sanitized;
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
  keyGenerator:    (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
});
app.use('/api/', limiter);

// ── Models ────────────────────────────────────────────────────────────────
const { connectionPromise, AttendanceRecord, User, Notification, RevokedToken } = require('./src/models/database');
const { v4: uuidv4 } = require('uuid');

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
          link:              '/manager/queue',
        });
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
// CRON 2 — Hourly reminder (18:00–23:00 IST): Remind employees to check out
//
// Sends a notification reminder only — does NOT flag or block anyone.
// The midnight cron above handles the actual flagging.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 18-23 * * *', async () => {
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
      const checkinDT    = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
      const nowIST       = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const hoursElapsed = (nowIST - checkinDT) / 3600000;

      if (hoursElapsed < 6) continue;

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
          message:           `${emp?.name || 'An employee'} checked in at ${record.checkin_time} on ${record.date} but has not checked out yet (${Math.floor(hoursElapsed)}h elapsed).`,
          type:              'warning',
          related_record_id: record._id,
          link:              '/manager/queue',
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
// CRON 3 — Every 15 min: Auto-checkout employees after 9 hours OR at 23:59 IST
//
// Whichever comes first:
//   a) check-in time + 9 hours  (normal shift limit)
//   b) 23:59 IST of the record's date  (EOD cutoff — day change safety net)
// ─────────────────────────────────────────────────────────────────────────────
// cron.schedule('*/15 * * * *', async () => {
//   try {
//     const unchecked = await AttendanceRecord.find({
//       status:        'Draft',
//       checkin_time:  { $ne: null },
//       checkout_time: null,
//     }).lean();

//     if (!unchecked.length) return;

//     const nowUTC = new Date();

//     for (const record of unchecked) {
//       const checkinDT      = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
//       const nineHourDT     = new Date(checkinDT.getTime() + 9 * 3600 * 1000);
//       const eodDT          = new Date(`${record.date}T23:59:00+05:30`);

//       // Use whichever limit is earlier — 9-hour mark or EOD (23:59 IST)
//       const effectiveDT  = nineHourDT <= eodDT ? nineHourDT : eodDT;
//       const isEodTrigger = effectiveDT === eodDT;

//       if (nowUTC < effectiveDT) continue;

//       // Format checkout time in IST as HH:MM
//       const checkoutTime = effectiveDT.toLocaleTimeString('en-CA', {
//         timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
//       });
//       const workedMs    = effectiveDT.getTime() - checkinDT.getTime();
//       const workedHours = Math.round(workedMs / 3600000 * 10) / 10;
//       const now         = new Date();

//       const remark = isEodTrigger
//         ? `Auto-checked out at end of day 23:59 (check-in: ${record.checkin_time}, checkout: ${checkoutTime})`
//         : `Auto-checked out after 9 hours (check-in: ${record.checkin_time}, checkout: ${checkoutTime})`;

//       await AttendanceRecord.findByIdAndUpdate(record._id, {
//         $set: {
//           checkout_time:    checkoutTime,
//           worked_hours:     workedHours,
//           is_auto_checkout: true,
//           status:           'Approved',
//           actioned_at:      now,
//           manager_remark:   remark,
//           submitted_at:     now,
//         },
//       });

//       await Notification.create({
//         _id:               uuidv4(),
//         user_id:           record.emp_id,
//         title:             isEodTrigger ? '🌙 Auto Check-Out (End of Day)' : '🕗 Auto Check-Out (9 Hours)',
//         message:           isEodTrigger
//           ? `You were automatically checked out at 23:59 (end of day). Worked ${workedHours}h.`
//           : `You were automatically checked out at ${checkoutTime} after 9 hours on duty.`,
//         type:              'info',
//         related_record_id: record._id,
//         link:              '/employee/history',
//       });

//       console.log(`[AutoCheckout Cron] ${record.emp_id} → ${checkoutTime} (${isEodTrigger ? 'EOD' : '9h'} trigger, ${workedHours}h worked)`);
//     }
//   } catch (err) {
//     console.error('[AutoCheckout Cron] Error:', err.message);
//   }
// });
// ─────────────────────────────────────────────────────────────────────────────
// CRON 3 — Every 15 min: Auto-checkout employees after 9 hours OR at 23:59 IST
//
// Whichever comes first:
//   a) check-in time + 9 hours  (matches AUTO_APPROVE_HOURS in checkout route)
//   b) 23:59 IST of the record's date  (EOD cutoff — day change safety net)
//
// If the employee checks out manually first, this cron does nothing to
// that record — the atomic guard below only fires when checkout_time is
// STILL null at the moment this cron writes.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('*/15 * * * *', async () => {
  try {
    const unchecked = await AttendanceRecord.find({
      status:        'Draft',
      checkin_time:  { $ne: null },
      checkout_time: null,
    }).lean();

    if (!unchecked.length) return;
    const nowUTC = new Date();

    for (const record of unchecked) {
      const checkinDT  = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
      const nineHourDT = new Date(checkinDT.getTime() + 9 * 3600 * 1000);
      const eodDT      = new Date(`${record.date}T23:59:00+05:30`);

      const effectiveDT  = nineHourDT <= eodDT ? nineHourDT : eodDT;
      const isEodTrigger = effectiveDT === eodDT;

      if (nowUTC < effectiveDT) continue; // not due yet

      const checkoutTime = effectiveDT.toLocaleTimeString('en-CA', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const workedHours = Math.round((effectiveDT - checkinDT) / 3600000 * 10) / 10;
      const now = new Date();
      const remark = isEodTrigger
        ? `Auto-checked out at end of day 23:59 (check-in: ${record.checkin_time}, checkout: ${checkoutTime})`
        : `Auto-checked out after 9 hours (check-in: ${record.checkin_time}, checkout: ${checkoutTime})`;

      // ATOMIC — only succeeds if checkout_time is STILL null right now.
      // If the employee's manual checkout landed first, this matches
      // zero documents and updated === null. Their record is untouched.
      const updated = await AttendanceRecord.findOneAndUpdate(
        { _id: record._id, checkout_time: null, status: 'Draft' },
        { $set: {
            checkout_time:             checkoutTime,
            worked_hours:              workedHours,
            is_auto_checkout:          true,
            status:                    'Approved',
            actioned_by:               null,
            actioned_at:               now,
            manager_remark:            remark,
            submitted_at:              now,
            checkout_location_address: 'System Auto-Checkout (no GPS captured)',
        }},
        { new: true }
      );

      if (!updated) {
        console.log(`[AutoCheckout Cron] ${record.emp_id} already checked out manually — skipped`);
        continue;
      }

      await Notification.create({
        _id: uuidv4(), user_id: record.emp_id,
        title: isEodTrigger ? '🌙 Auto Check-Out (End of Day)' : '🕗 Auto Check-Out (9 Hours)',
        message: isEodTrigger
          ? `You were automatically checked out at 23:59 (end of day). Worked ${workedHours}h.`
          : `You were automatically checked out at ${checkoutTime} after 9 hours on duty.`,
        type: 'info', related_record_id: record._id, link: '/employee/history',
      });

      console.log(`[AutoCheckout Cron] ${record.emp_id} → ${checkoutTime} (${isEodTrigger ? 'EOD' : '9h'} trigger, ${workedHours}h worked)`);
    }
  } catch (err) {
    console.error('[AutoCheckout Cron] Error:', err.message);
  }
});

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
app.use('/api/dept-dashboard',    require('./src/routes/dept-dashboard'));
app.use('/api/geocode',           require('./src/routes/geocode'));
app.use('/api/holidays',          require('./src/routes/holidays'));
app.use('/api/file',              require('./src/routes/file'));

// Health check — version bump triggers Render redeploy detection
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.2.0',
    msmeUnfiltered: true,  // confirms MSME route no longer filters by block for employees
  });
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