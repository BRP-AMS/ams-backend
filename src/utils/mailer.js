/**
 * Shared SMTP mailer — single transporter reused across all routes.
 * Sanitises SMTP_FROM so it works whether the env var includes quotes or not.
 */
const nodemailer = require('nodemailer');

// ── Sanitise SMTP_FROM ───────────────────────────────────────────────────────
// Render dashboard values are raw strings; .env values may be quoted by dotenv.
// Strip any surrounding double-quotes so nodemailer always gets a clean RFC 5322 address.
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || '').replace(/^"|"$/g, '').trim();

// ── Create transporter (once) ────────────────────────────────────────────────
const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Gmail sometimes needs these:
      tls:    { rejectUnauthorized: false },
    })
  : null;

// ── Verify on first load ─────────────────────────────────────────────────────
if (transporter) {
  transporter.verify()
    .then(() => console.log('✅ SMTP mailer ready  |  from:', rawFrom))
    .catch(err => console.error('❌ SMTP verify FAILED:', err.message, '| code:', err.code));
}

// ── sendMail ─────────────────────────────────────────────────────────────────
const sendMail = async (to, subject, html) => {
  if (!transporter) {
    console.warn('[Email] SMTP not configured (SMTP_HOST missing). Skipping:', subject);
    return;
  }
  console.log(`[Email] Sending "${subject}" → ${to}  (from: ${rawFrom})`);
  try {
    const info = await transporter.sendMail({ from: rawFrom, to, subject, html });
    console.log('[Email] ✅ Sent OK. MessageId:', info.messageId);
    return info;
  } catch (err) {
    console.error('[Email] ❌ Send FAILED:', err.message, '| code:', err.code, '| response:', err.response);
    throw err;                // re-throw so callers can .catch() if needed
  }
};

module.exports = { sendMail, transporter };
