/**
 * Shared SMTP mailer — single transporter reused across all routes.
 *
 * Render free-tier blocks outbound port 587 (STARTTLS).
 * Fix: use port 465 with secure:true (direct SSL) which Render allows.
 * The SMTP_PORT / SMTP_SECURE env vars override this if set.
 */
const nodemailer = require('nodemailer');

// ── Sanitise SMTP_FROM ───────────────────────────────────────────────────────
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || '').replace(/^"|"$/g, '').trim();

// ── Determine port & security ────────────────────────────────────────────────
// Default to 465/SSL (works on Render), fall back to env overrides
const smtpPort   = parseInt(process.env.SMTP_PORT || '465');
const smtpSecure = process.env.SMTP_SECURE != null
  ? process.env.SMTP_SECURE === 'true'
  : smtpPort === 465;   // auto-detect: 465 = SSL, else STARTTLS

console.log('[Mailer] ENV →',
  'HOST:', process.env.SMTP_HOST || '(missing)',
  '| PORT:', smtpPort,
  '| SECURE:', smtpSecure,
  '| USER:', process.env.SMTP_USER || '(missing)',
  '| PASS:', process.env.SMTP_PASS ? '****' + process.env.SMTP_PASS.slice(-4) : '(missing)',
  '| FROM:', rawFrom || '(missing)',
);

// ── Create transporter (once) ────────────────────────────────────────────────
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  console.log('[Mailer] Creating transporter →', process.env.SMTP_HOST + ':' + smtpPort, smtpSecure ? '(SSL)' : '(STARTTLS)');
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   smtpPort,
    secure: smtpSecure,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout:   15000,
    socketTimeout:     20000,
  });

  // Verify connection
  transporter.verify()
    .then(() => console.log('✅ SMTP mailer ready  |  from:', rawFrom))
    .catch(err => console.error('❌ SMTP verify FAILED:', err.message, '| code:', err.code));
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
