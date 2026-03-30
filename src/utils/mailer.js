/**
 * Shared email sender.
 *
 * Priority order:
 *   1. GMAIL_RELAY_URL set  → sends via Google Apps Script relay (HTTPS, port 443 — works everywhere)
 *   2. SMTP_HOST set        → sends via nodemailer SMTP (works locally, NOT on Render)
 *   3. FIREBASE_API_KEY set → Firebase Auth REST API (password reset / verify only)
 *
 * Render free-tier silently drops SMTP traffic. The Google Apps Script relay
 * sends via Gmail's own infrastructure over HTTPS — always works.
 */

const nodemailer = require('nodemailer');

// ── FROM address ─────────────────────────────────────────────────────────────
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@example.com')
  .replace(/^"|"$/g, '').trim();

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — Google Apps Script Email Relay (HTTPS, always works)
// ═══════════════════════════════════════════════════════════════════════════════
const GMAIL_RELAY_URL = process.env.GMAIL_RELAY_URL;

const sendViaGmailRelay = async (to, subject, html) => {
  if (!GMAIL_RELAY_URL) throw new Error('GMAIL_RELAY_URL not set');
  console.log(`[Email/GmailRelay] Sending "${subject}" → ${to}`);
  const res = await fetch(GMAIL_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, html }),
    redirect: 'follow',
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (body.success === false) {
    console.error('[Email/GmailRelay] ❌ FAILED:', JSON.stringify(body));
    throw new Error(body.error || 'Gmail relay failed');
  }
  console.log('[Email/GmailRelay] ✅ Sent OK');
  return body;
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — Nodemailer SMTP (works locally, NOT on Render)
// ═══════════════════════════════════════════════════════════════════════════════
let transporter = null;

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
}

const sendViaSMTP = async (to, subject, html) => {
  if (!transporter) throw new Error('SMTP not configured');
  console.log(`[Email/SMTP] Sending "${subject}" → ${to}  (from: ${rawFrom})`);
  const info = await transporter.sendMail({ from: rawFrom, to, subject, html });
  console.log('[Email/SMTP] ✅ Sent OK. MessageId:', info.messageId);
  return info;
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MODE 3 — Firebase Auth REST API (fallback for password reset / verify)
// ═══════════════════════════════════════════════════════════════════════════════
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const { sendPasswordResetEmail, sendVerificationEmail, createFirebaseUser } =
  require('./firebaseMailer');

// ═══════════════════════════════════════════════════════════════════════════════
//  Unified sendMail
// ═══════════════════════════════════════════════════════════════════════════════
const primaryMode = GMAIL_RELAY_URL ? 'gmail_relay' : transporter ? 'smtp' : FIREBASE_API_KEY ? 'firebase' : 'none';
console.log(`[Mailer] Primary mode: ${primaryMode.toUpperCase()}  |  from: ${rawFrom}`);

/**
 * Send an email.
 * @param {string} to       - recipient email
 * @param {string} subject  - email subject
 * @param {string} html     - HTML body
 * @param {object} options  - { type: 'VERIFY_EMAIL' | 'PASSWORD_RESET', password: '...' }
 */
const sendMail = async (to, subject, html, options = {}) => {
  // ── Try Google Apps Script relay first (HTTPS, works on Render) ──
  if (GMAIL_RELAY_URL) {
    try {
      return await sendViaGmailRelay(to, subject, html);
    } catch (err) {
      console.error('[Email/GmailRelay] ❌ Failed:', err.message, '— trying fallback...');
    }
  }

  // ── Try SMTP (works locally) ──
  if (transporter) {
    try {
      return await sendViaSMTP(to, subject, html);
    } catch (err) {
      console.error('[Email/SMTP] ❌ Failed:', err.message, '— trying fallback...');
    }
  }

  // ── Firebase fallback (password reset / verify only) ──
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
