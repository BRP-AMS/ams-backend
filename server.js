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
  'https://mm-services.brptripura.com',
  'https://monitormark-frontend.onrender.com',
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

// Shared by the reminder crons below — skip Saturdays, Sundays, and
// configured holidays. Saturday+Sunday matches the week-off rule used
// everywhere else in the app (see isNonWorkingDay in reports.js) — this
// used to only skip Sunday, so these crons incorrectly fired on Saturdays.
const isNonWorkingDayForReminders = async (dateIST) => {
  const dow = new Date(dateIST + 'T00:00:00+05:30').getDay();
  if (dow === 0 || dow === 6) return true; // Sunday or Saturday
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
// CRON 5 — 00:10 IST on the 1st of each month: monthly leave accrual.
// Credits +1 leave day to every active employee with auto_leave_enabled
// (default true). Guarded by last_accrual_date so a duplicate cron fire
// on the same day never double-credits.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('10 0 1 * *', async () => {
  console.log('[Leave Accrual] Cron triggered');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const employees = await User.find({
      role: 'employee', is_active: { $ne: 0 },
      auto_leave_enabled: { $ne: false },
      last_accrual_date: { $ne: todayIST },
    }).select('_id').lean();

    if (!employees.length) { console.log('[Leave Accrual] Nothing to accrue.'); return; }

    await User.updateMany(
      { _id: { $in: employees.map(e => e._id) } },
      { $inc: { leave_balance: 1 }, $set: { last_accrual_date: todayIST } }
    );
    console.log(`[Leave Accrual] +1 day credited to ${employees.length} employee(s) on ${todayIST}.`);
  } catch (err) {
    console.error('[Leave Accrual] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON 6 — 10:05 AM IST, working days only: "Not checked-in yet" alert email
// to managers (their own team) and admin-level roles (whole org).
//
// An employee counts as "not checked in" if they have no attendance record
// for today with checkin_time set, AND they aren't on an admin-approved
// leave covering today (same leaveFilter shape as GET /today-checkin-status
// in attendance.js, for consistency). Skips Sundays/holidays. Sends nothing
// when a manager's/the org's list is empty — no "all clear" noise mail.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('5 10 * * *', async () => {
  console.log('[NotCheckedIn Alert] Cron triggered');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (await isNonWorkingDayForReminders(todayIST)) return console.log('[NotCheckedIn Alert] Skipped — non-working day');

    // Idempotency guard — Render can briefly run two instances at once
    // during a deploy (or restart), and each has its own in-process cron
    // scheduler, so the same wall-clock minute can fire this job twice,
    // sending every email twice. A unique _id per cron+day means only the
    // first instance to insert wins; the second gets a duplicate-key error
    // and skips, instead of resending everything.
    try {
      await User.db.collection('cron_runs').insertOne({ _id: `notCheckedInAlert_${todayIST}`, ranAt: new Date() });
    } catch (err) {
      if (err.code === 11000) return console.log('[NotCheckedIn Alert] Already sent today (by this or another instance) — skipping.');
      throw err;
    }

    const employees = await User.find({ role: 'employee', is_active: { $ne: 0 } })
      .select('_id emp_id name manager_id assigned_block assigned_district').lean();
    if (!employees.length) return console.log('[NotCheckedIn Alert] No active employees.');

    const checkedInIds = new Set(
      (await AttendanceRecord.find({ date: todayIST, checkin_time: { $ne: null } }).select('emp_id').lean())
        .map(r => String(r.emp_id))
    );
    const leaveFilter = {
      duty_type: 'Leave', leave_status: 'Approved',
      $or: [{ date: todayIST, end_date: null }, { date: { $lte: todayIST }, end_date: { $gte: todayIST } }],
    };
    const onLeaveIds = new Set(
      (await AttendanceRecord.find(leaveFilter).select('emp_id').lean()).map(r => String(r.emp_id))
    );

    const notCheckedIn = employees.filter(e => !checkedInIds.has(String(e._id)) && !onLeaveIds.has(String(e._id)));
    console.log(`[NotCheckedIn Alert] ${notCheckedIn.length} of ${employees.length} employee(s) not checked in as of 10:05 AM.`);
    if (!notCheckedIn.length) return;

    const dateLabel = new Date(todayIST + 'T00:00:00+05:30')
      .toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

    const rowsHtml = list => `
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <tr style="background:#F1F5F9;text-align:left;">
          <th style="padding:6px 10px;border:1px solid #E2E8F0;">Name</th>
          <th style="padding:6px 10px;border:1px solid #E2E8F0;">Emp ID</th>
          <th style="padding:6px 10px;border:1px solid #E2E8F0;">Block</th>
        </tr>
        ${list.map(e => `
          <tr>
            <td style="padding:6px 10px;border:1px solid #E2E8F0;">${e.name}</td>
            <td style="padding:6px 10px;border:1px solid #E2E8F0;">${e.emp_id || '—'}</td>
            <td style="padding:6px 10px;border:1px solid #E2E8F0;">${e.assigned_block || '—'}</td>
          </tr>`).join('')}
      </table>`;

    // ── Per-manager emails — each manager's own team only ──────────────────
    const byManager = new Map();
    for (const e of notCheckedIn) {
      if (!e.manager_id) continue;
      if (!byManager.has(e.manager_id)) byManager.set(e.manager_id, []);
      byManager.get(e.manager_id).push(e);
    }
    let managerEmailsSent = 0;
    for (const [managerId, team] of byManager) {
      const manager = await User.findById(managerId).select('name email').lean();
      if (!manager?.email) continue;
      await sendMail(
        manager.email, `[AMS] ${team.length} Not Checked In Today — ${dateLabel}`,
        `<p>Hi ${manager.name || 'there'},</p>
         <p><strong>${team.length}</strong> of your team member(s) had not checked in as of 10:05 AM on ${dateLabel}:</p>
         ${rowsHtml(team)}`
      ).catch(err => console.error('[NotCheckedIn Alert] Manager email failed:', manager.email, err.message));
      managerEmailsSent++;
    }

    // ── Org-wide email to admin-level roles ─────────────────────────────────
    const overseers = await User.find({ role: { $in: ['admin', 'super_admin', 'hr'] }, is_active: { $ne: 0 } })
      .select('name email').lean();
    let adminEmailsSent = 0;
    for (const o of overseers) {
      if (!o.email) continue;
      await sendMail(
        o.email, `[AMS] ${notCheckedIn.length} Not Checked In Today — ${dateLabel}`,
        `<p>Hi ${o.name || 'there'},</p>
         <p><strong>${notCheckedIn.length}</strong> of ${employees.length} employee(s) had not checked in as of 10:05 AM on ${dateLabel}:</p>
         ${rowsHtml(notCheckedIn)}`
      ).catch(err => console.error('[NotCheckedIn Alert] Admin email failed:', o.email, err.message));
      adminEmailsSent++;
    }

    console.log(`[NotCheckedIn Alert] Sent ${managerEmailsSent} manager email(s), ${adminEmailsSent} admin-level email(s).`);
  } catch (err) {
    console.error('[NotCheckedIn Alert] Error:', err.message);
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