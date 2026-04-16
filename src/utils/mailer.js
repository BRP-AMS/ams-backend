/**
 * Email delivery — TWO channels:
 *
 *   AUTH emails  → Firebase Auth REST API
 *                    • first-time password (invites user to set password)
 *                    • password reset
 *                    • email verification
 *                  Firebase renders its own HTML using the templates you
 *                  configure in Firebase Console → Authentication → Templates.
 *                  Custom per-send HTML is NOT supported on this channel.
 *
 *   BUSINESS emails → Resend HTTP API  (custom HTML, per-send)
 *                    • leave requests / approvals / rejections
 *                    • admin notifications
 *                    • re-apply notifications
 *                    • OTPs (cannot go via Firebase)
 *
 * Gmail SMTP relay (nodemailer) has been removed — Render free-tier blocks
 * outbound SMTP anyway, and keeping a legacy transport invited accidental use.
 *
 * Required env:
 *   FIREBASE_API_KEY  — web API key (Firebase Console → Project settings)
 *   RESEND_API_KEY    — HTTP API key from resend.com
 *   SMTP_FROM         — "BRP AMS <noreply@yourdomain>"  (used as Resend from addr)
 */

const {
  sendPasswordResetEmail: firebaseSendPasswordReset,
  sendVerificationEmail:  firebaseSendVerification,
  createFirebaseUser,
  ensureFirebaseUser,
} = require('./firebaseMailer');

// ── FROM address (sanitised) ─────────────────────────────────────────────────
const rawFrom = (process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@example.com')
  .replace(/^"|"$/g, '').trim();

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const RESEND_KEY       = process.env.RESEND_API_KEY;

if (!FIREBASE_API_KEY) {
  console.warn('[Mailer] ⚠️  FIREBASE_API_KEY not set — auth emails will fail');
} else {
  console.log('[Mailer] ✅ Firebase channel ready (auth emails)');
}
if (!RESEND_KEY) {
  console.warn('[Mailer] ⚠️  RESEND_API_KEY not set — business emails will fail');
} else {
  console.log(`[Mailer] ✅ Resend channel ready (business emails) · from: ${rawFrom}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUSINESS CHANNEL — Resend HTTP API (custom HTML)
// ═══════════════════════════════════════════════════════════════════════════════
const sendViaResend = async (to, subject, html) => {
  if (!RESEND_KEY) {
    console.error('[Email/Resend] ❌ RESEND_API_KEY not set — cannot deliver:', subject, '→', to);
    throw new Error('RESEND_API_KEY not configured');
  }
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

/**
 * Send a business (non-auth) email with custom HTML via Resend.
 * Use for leave requests, admin notifications, OTPs, re-apply, etc.
 */
const sendBusinessEmail = async (to, subject, html) => sendViaResend(to, subject, html);

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH CHANNEL — Firebase Auth REST API (Firebase-templated emails)
// ═══════════════════════════════════════════════════════════════════════════════
const AUTH_TYPES = new Set(['FIRST_TIME_PASSWORD', 'PASSWORD_RESET', 'VERIFY_EMAIL']);

/**
 * Send an auth email via Firebase. Firebase renders its own HTML template.
 *
 * @param {string} email  — recipient
 * @param {'FIRST_TIME_PASSWORD'|'PASSWORD_RESET'|'VERIFY_EMAIL'} type
 * @param {object} [opts]
 * @param {string} [opts.password] — temp password used to create the shadow user
 *                                   (only relevant for FIRST_TIME_PASSWORD)
 */
const sendAuthEmail = async (email, type, opts = {}) => {
  if (!AUTH_TYPES.has(type)) throw new Error(`Invalid auth email type: ${type}`);
  if (!FIREBASE_API_KEY) {
    console.error('[Email/Firebase] ❌ FIREBASE_API_KEY not set — cannot deliver:', type, '→', email);
    throw new Error('FIREBASE_API_KEY not configured');
  }

  // FIRST_TIME_PASSWORD: create the Firebase user with the temp password, then
  // send a PASSWORD_RESET email so the employee sets their own password on
  // first login. Firebase's template explains this ("a password reset was
  // requested for your account") — it maps cleanly to the onboarding flow.
  if (type === 'FIRST_TIME_PASSWORD') {
    return firebaseSendPasswordReset(email, opts.password);
  }
  if (type === 'PASSWORD_RESET') {
    return firebaseSendPasswordReset(email);
  }
  if (type === 'VERIFY_EMAIL') {
    return firebaseSendVerification(email, opts.password);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Backward-compat sendMail
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Legacy entry-point retained so existing call sites keep working during the
 * migration. Routes:
 *   • options.type in AUTH_TYPES → Firebase (auth channel)
 *   • everything else            → Resend   (business channel, uses `html`)
 */
const sendMail = async (to, subject, html, options = {}) => {
  if (options.type && AUTH_TYPES.has(options.type)) {
    return sendAuthEmail(to, options.type, options);
  }
  return sendViaResend(to, subject, html);
};

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Escape HTML special chars for safe interpolation into email templates.
 * Prevents stored XSS via user-controlled fields (name, email, remark) reaching
 * other users' inboxes where the mail client may render them as HTML.
 */
const escapeHtml = (val) => {
  if (val == null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

module.exports = {
  sendMail,            // backward-compat
  sendAuthEmail,       // Firebase auth emails
  sendBusinessEmail,   // Resend custom HTML emails
  createFirebaseUser,
  ensureFirebaseUser,
  escapeHtml,
  fromAddress: rawFrom,
};
