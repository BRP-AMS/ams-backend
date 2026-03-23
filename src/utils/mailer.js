/**
 * Shared email sender.
 *
 * Supports TWO modes (auto-detected):
 *   1. RESEND_API_KEY set  → sends via Resend HTTP API (works on Render)
 *   2. SMTP_HOST set       → sends via nodemailer SMTP  (works locally / non-Render)
 *
 * Render free-tier blocks ALL outbound SMTP (ports 25, 465, 587).
 * Resend is free (100 emails/day, 3 000/month) and uses HTTPS (port 443).
 */

const nodemailer = require('nodemailer');

// ── FROM address (sanitised) ─────────────────────────────────────────────────
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@example.com')
  .replace(/^"|"$/g, '').trim();

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — Resend HTTP API  (preferred on Render)
// ═══════════════════════════════════════════════════════════════════════════════
const RESEND_KEY = process.env.RESEND_API_KEY;

const sendViaResend = async (to, subject, html) => {
  console.log(`[Email/Resend] Sending "${subject}" → ${to}`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: rawFrom, to: [to], subject, html }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error('[Email/Resend] ❌ FAILED:', JSON.stringify(body));
    throw new Error(body.message || `Resend API error ${res.status}`);
  }
  console.log('[Email/Resend] ✅ Sent OK. id:', body.id);
  return body;
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — Nodemailer SMTP  (local / non-Render)
// ═══════════════════════════════════════════════════════════════════════════════
let transporter = null;

if (!RESEND_KEY && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const smtpPort   = parseInt(process.env.SMTP_PORT || '465');
  const smtpSecure = process.env.SMTP_SECURE != null
    ? process.env.SMTP_SECURE === 'true'
    : smtpPort === 465;

  console.log('[Mailer] SMTP mode →', process.env.SMTP_HOST + ':' + smtpPort, smtpSecure ? '(SSL)' : '(STARTTLS)');
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
  transporter.verify()
    .then(() => console.log('✅ SMTP mailer ready  |  from:', rawFrom))
    .catch(err => console.error('❌ SMTP verify FAILED:', err.message, '| code:', err.code));
}

const sendViaSMTP = async (to, subject, html) => {
  console.log(`[Email/SMTP] Sending "${subject}" → ${to}  (from: ${rawFrom})`);
  const info = await transporter.sendMail({ from: rawFrom, to, subject, html });
  console.log('[Email/SMTP] ✅ Sent OK. MessageId:', info.messageId);
  return info;
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Unified sendMail
// ═══════════════════════════════════════════════════════════════════════════════
const mode = RESEND_KEY ? 'resend' : transporter ? 'smtp' : 'none';
console.log(`[Mailer] Active mode: ${mode.toUpperCase()}  |  from: ${rawFrom}`);

const sendMail = async (to, subject, html) => {
  if (mode === 'resend') return sendViaResend(to, subject, html);
  if (mode === 'smtp')   return sendViaSMTP(to, subject, html);
  console.error('[Email] ⚠️  No email provider configured! Set RESEND_API_KEY or SMTP_HOST. Skipping:', subject, '→', to);
};

module.exports = { sendMail, transporter, mode };
