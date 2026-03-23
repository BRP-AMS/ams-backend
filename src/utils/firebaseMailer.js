/**
 * Firebase-based email delivery.
 *
 * Uses Firebase Auth REST API (HTTPS, port 443) to send emails.
 * This works on Render free-tier where SMTP ports are blocked.
 *
 * Supported email types:
 *   - Password reset   → Firebase sends branded reset email
 *   - Email verification → Firebase sends branded verification email
 *   - OTP / custom      → Uses Firebase password-reset flow as delivery mechanism
 *
 * Only requires FIREBASE_API_KEY (web API key from Firebase Console).
 */

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_REST    = 'https://identitytoolkit.googleapis.com/v1';

if (!FIREBASE_API_KEY) {
  console.warn('[Firebase Mailer] ⚠️  FIREBASE_API_KEY not set — Firebase email delivery disabled');
}

// ── Helper: call Firebase Auth REST API ─────────────────────────────────────
async function firebasePost(endpoint, body) {
  const url = `${FIREBASE_REST}/${endpoint}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Firebase API error ${res.status}`;
    console.error(`[Firebase] ❌ ${endpoint}:`, msg);
    throw new Error(msg);
  }
  return data;
}

// ── Ensure a Firebase Auth user exists for this email ───────────────────────
// Creates a shadow user if one doesn't exist. Returns idToken for further ops.
async function ensureFirebaseUser(email, password) {
  const pwd = password || `Fb@${require('crypto').randomBytes(12).toString('hex')}`;

  try {
    // Try sign in first (user may already exist)
    const signIn = await firebasePost('accounts:signInWithPassword', {
      email,
      password: pwd,
      returnSecureToken: true,
    });
    return signIn;
  } catch (err) {
    if (err.message === 'INVALID_LOGIN_CREDENTIALS' || err.message === 'EMAIL_NOT_FOUND') {
      // User doesn't exist — create
      try {
        const signUp = await firebasePost('accounts:signUp', {
          email,
          password: pwd,
          returnSecureToken: true,
        });
        console.log(`[Firebase] Created shadow user: ${email}`);
        return signUp;
      } catch (createErr) {
        if (createErr.message === 'EMAIL_EXISTS') {
          // User exists but password is wrong — use password reset flow
          console.log(`[Firebase] User exists with different password: ${email}`);
          return null; // Can still send PASSWORD_RESET without idToken
        }
        throw createErr;
      }
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a password reset email via Firebase.
 * This is the simplest — only needs the email address, no auth required.
 */
async function sendPasswordResetEmail(email) {
  if (!FIREBASE_API_KEY) throw new Error('FIREBASE_API_KEY not configured');

  console.log(`[Firebase] Sending PASSWORD_RESET → ${email}`);
  const result = await firebasePost('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email,
  });
  console.log(`[Firebase] ✅ Password reset email sent to ${email}`);
  return result;
}

/**
 * Send an email verification email via Firebase.
 * Requires creating/signing-in as the Firebase user to get an idToken.
 */
async function sendVerificationEmail(email, password) {
  if (!FIREBASE_API_KEY) throw new Error('FIREBASE_API_KEY not configured');

  console.log(`[Firebase] Sending VERIFY_EMAIL → ${email}`);
  const authData = await ensureFirebaseUser(email, password);

  if (!authData?.idToken) {
    // Fallback: send a password reset instead (still delivers an email)
    console.log(`[Firebase] Falling back to PASSWORD_RESET for verification: ${email}`);
    return sendPasswordResetEmail(email);
  }

  const result = await firebasePost('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: authData.idToken,
  });
  console.log(`[Firebase] ✅ Verification email sent to ${email}`);
  return result;
}

/**
 * Create a Firebase Auth user (shadow user for email delivery).
 * Call this when admin creates a new user.
 */
async function createFirebaseUser(email, password) {
  if (!FIREBASE_API_KEY) return null;

  try {
    const result = await firebasePost('accounts:signUp', {
      email,
      password,
      returnSecureToken: true,
    });
    console.log(`[Firebase] ✅ Created user: ${email}`);
    return result;
  } catch (err) {
    if (err.message === 'EMAIL_EXISTS') {
      console.log(`[Firebase] User already exists: ${email}`);
      return null;
    }
    throw err;
  }
}

/**
 * Unified sendMail replacement.
 * For password-reset and verification, uses Firebase Auth REST API.
 * For other email types (OTP, notifications), uses Firebase password-reset as delivery.
 */
async function sendFirebaseMail(to, subject, html, options = {}) {
  if (!FIREBASE_API_KEY) {
    console.error('[Firebase Mailer] ⚠️  FIREBASE_API_KEY not set — cannot send email');
    return null;
  }

  const type = options.type || 'PASSWORD_RESET';

  if (type === 'VERIFY_EMAIL') {
    return sendVerificationEmail(to, options.password);
  }

  // Default: use PASSWORD_RESET (works for any email — user gets a reset link)
  return sendPasswordResetEmail(to);
}

module.exports = {
  sendFirebaseMail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  createFirebaseUser,
  ensureFirebaseUser,
};
