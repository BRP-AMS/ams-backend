/**
 * Shared SMTP mailer — single transporter reused across all routes.
 * Sanitises SMTP_FROM so it works whether the env var includes quotes or not.
 */
const nodemailer = require('nodemailer');

// ── Debug: log what env vars are actually available ──────────────────────────
console.log('[Mailer] ENV check →',
  'SMTP_HOST:', process.env.SMTP_HOST || '(missing)',
  '| SMTP_PORT:', process.env.SMTP_PORT || '(missing)',
  '| SMTP_USER:', process.env.SMTP_USER || '(missing)',
  '| SMTP_PASS:', process.env.SMTP_PASS ? '****' + process.env.SMTP_PASS.slice(-4) : '(missing)',
  '| SMTP_FROM:', process.env.SMTP_FROM || '(missing)',
  '| SMTP_SECURE:', process.env.SMTP_SECURE || '(missing)',
);

// ── Sanitise SMTP_FROM ───────────────────────────────────────────────────────
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || '').replace(/^"|"$/g, '').trim();

// ── Create transporter (once) ────────────────────────────────────────────────
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  console.log('[Mailer] Creating transporter →', process.env.SMTP_HOST + ':' + (process.env.SMTP_PORT || '587'));
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
  });

  // Verify connection
  transporter.verify()
    .then(() => console.log('✅ SMTP mailer ready  |  from:', rawFrom))
    .catch(err => console.error('❌ SMTP verify FAILED:', err.message, '| code:', err.code, '| full:', err));
} else {
  console.warn('⚠️  [Mailer] SMTP not configured — missing:',
    !process.env.SMTP_HOST ? 'SMTP_HOST' : '',
    !process.env.SMTP_USER ? 'SMTP_USER' : '',
    !process.env.SMTP_PASS ? 'SMTP_PASS' : '',
  );
}

// ── sendMail ─────────────────────────────────────────────────────────────────
const sendMail = async (to, subject, html) => {
  if (!transporter) {
    console.error('[Email] ⚠️  No transporter! SMTP not configured. Skipping:', subject, '→', to);
    return;
  }
  console.log(`[Email] Sending "${subject}" → ${to}  (from: ${rawFrom})`);
  try {
    const info = await transporter.sendMail({ from: rawFrom, to, subject, html });
    console.log('[Email] ✅ Sent OK. MessageId:', info.messageId, '| accepted:', info.accepted);
    return info;
  } catch (err) {
    console.error('[Email] ❌ Send FAILED:', err.message, '| code:', err.code, '| command:', err.command, '| response:', err.response);
    throw err;
  }
};

module.exports = { sendMail, transporter };
