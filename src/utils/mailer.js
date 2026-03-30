/**
 * Shared email sender.
 *
 * Priority order (SMTP first for branded emails):
 *   1. SMTP_HOST set        → sends via nodemailer SMTP (branded from noreply.brpams@gmail.com)
 *   2. RESEND_API_KEY set   → sends via Resend HTTP API
 *   3. FIREBASE_API_KEY set → sends via Firebase Auth REST API (fallback)
 *
 * SMTP on port 587 (STARTTLS) works on most hosts including local dev.
 * Firebase is kept as fallback for Render free-tier (blocks SMTP ports).
 */

const nodemailer = require('nodemailer');

// ── FROM address (sanitised) ─────────────────────────────────────────────────
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@example.com')
  .replace(/^"|"$/g, '').trim();

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — Nodemailer SMTP (preferred — branded emails)
// ═══════════════════════════════════════════════════════════════════════════════
let transporter = null;
let smtpVerified = false;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const smtpPort   = parseInt(process.env.SMTP_PORT || '587');
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
    connectionTimeout: 5000,
    greetingTimeout:   5000,
    socketTimeout:     10000,
  });
  transporter.verify()
    .then(() => {
      smtpVerified = true;
      console.log('✅ SMTP mailer ready  |  from:', rawFrom);
    })
    .catch(err => {
      smtpVerified = false;
      transporter = null; // Disable SMTP so fallback is instant
      console.error('❌ SMTP verify FAILED:', err.message, '| code:', err.code,
        '— SMTP disabled, using Firebase/Resend fallback');
    });
}

const sendViaSMTP = async (to, subject, html) => {
  if (!transporter) throw new Error('SMTP not configured');
  console.log(`[Email/SMTP] Sending "${subject}" → ${to}  (from: ${rawFrom})`);
  const info = await transporter.sendMail({ from: rawFrom, to, subject, html });
  console.log('[Email/SMTP] ✅ Sent OK. MessageId:', info.messageId);
  return info;
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — Resend HTTP API
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
//  MODE 3 — Firebase Auth REST API (fallback)
// ═══════════════════════════════════════════════════════════════════════════════
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const { sendPasswordResetEmail, sendVerificationEmail, createFirebaseUser } =
  require('./firebaseMailer');

// ═══════════════════════════════════════════════════════════════════════════════
//  Unified sendMail — SMTP first, then Resend, then Firebase fallback
// ═══════════════════════════════════════════════════════════════════════════════
const primaryMode = transporter ? 'smtp' : RESEND_KEY ? 'resend' : FIREBASE_API_KEY ? 'firebase' : 'none';
console.log(`[Mailer] Primary mode: ${primaryMode.toUpperCase()}  |  from: ${rawFrom}`);
if (FIREBASE_API_KEY && primaryMode !== 'firebase') {
  console.log(`[Mailer] Firebase available as fallback`);
}

/**
 * Send an email.
 * @param {string} to       - recipient email
 * @param {string} subject  - email subject
 * @param {string} html     - HTML body
 * @param {object} options  - { type: 'VERIFY_EMAIL' | 'PASSWORD_RESET', password: '...' }
 */
const sendMail = async (to, subject, html, options = {}) => {
  // ── Try SMTP first (branded emails from noreply.brpams@gmail.com) ──
  if (transporter) {
    try {
      return await sendViaSMTP(to, subject, html);
    } catch (err) {
      console.error('[Email/SMTP] ❌ Failed:', err.message, '— trying fallback...');
    }
  }

  // ── Try Resend ──
  if (RESEND_KEY) {
    try {
      return await sendViaResend(to, subject, html);
    } catch (err) {
      console.error('[Email/Resend] ❌ Failed:', err.message, '— trying fallback...');
    }
  }

  // ── Firebase fallback ──
  if (FIREBASE_API_KEY) {
    const type = options.type
      || (subject.toLowerCase().includes('verify') || subject.toLowerCase().includes('welcome')
          ? 'VERIFY_EMAIL'
          : 'PASSWORD_RESET');

    if (type === 'VERIFY_EMAIL') {
      return sendVerificationEmail(to, options.password);
    }
    return sendPasswordResetEmail(to);
  }

  console.error('[Email] ⚠️  No email provider available! Skipping:', subject, '→', to);
};

module.exports = { sendMail, transporter, mode: primaryMode, sendPasswordResetEmail, sendVerificationEmail, createFirebaseUser };
