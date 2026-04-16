/**
 * Branded email HTML templates for business emails delivered via Resend.
 *
 * Auth emails (first-time password, password reset, email verification) go
 * through Firebase Auth REST API and use Firebase's own templates — those are
 * configured in Firebase Console → Authentication → Templates, not here.
 *
 * Every field interpolated into these templates MUST be pre-escaped with
 * escapeHtml() if it originates from user input (emp name, reason, remark, …).
 */

const { escapeHtml } = require('./mailer');

// ── Branded layout wrapper (shared by every business email) ─────────────────
const emailLayout = (title, bodyHtml) => `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP · AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">${title}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">
    Do not reply to this email · BRP AMS Automated System
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  if (isNaN(d)) return escapeHtml(s);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const row = (label, value) => `
  <tr>
    <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:13px;font-weight:600;width:180px;">${escapeHtml(label)}</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#0b1e3b;font-size:13px;">${value}</td>
  </tr>`;

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fallback HTML for first-time password onboarding (used ONLY if Firebase is
 * unavailable and we have to send via Resend). Auth flow normally routes
 * through Firebase, which renders its own template.
 */
const firstTimePasswordEmailHtml = ({ userName, empId, loginUrl }) => emailLayout(
  'Welcome to BRP AMS',
  `<p style="color:#475569;font-size:14px;line-height:1.6;">
     Hi <strong>${escapeHtml(userName)}</strong>,
   </p>
   <p style="color:#475569;font-size:14px;line-height:1.6;">
     Your AMS account has been created. Your Employee ID is
     <strong>${escapeHtml(empId)}</strong>.
   </p>
   <p style="color:#475569;font-size:14px;line-height:1.6;">
     Please click below to set your password and sign in for the first time.
   </p>
   <div style="text-align:center;margin:28px 0;">
     <a href="${escapeHtml(loginUrl)}"
        style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
               text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
       Set My Password
     </a>
   </div>
   <p style="color:#dc2626;font-size:13px;">
     If you did not expect this email, please contact your administrator.
   </p>`
);

/**
 * Fallback HTML for password reset (normally delivered via Firebase).
 */
const passwordResetEmailHtml = ({ userName, resetUrl }) => emailLayout(
  'Password Reset Request',
  `<p style="color:#475569;font-size:14px;line-height:1.6;">
     Hi <strong>${escapeHtml(userName)}</strong>, we received a request to reset your AMS password.
   </p>
   <p style="color:#475569;font-size:14px;line-height:1.6;">
     Click the button below. This link expires in <strong>5 minutes</strong>.
   </p>
   <div style="text-align:center;margin:28px 0;">
     <a href="${escapeHtml(resetUrl)}"
        style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
               text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
       Reset Password
     </a>
   </div>
   <p style="color:#94a3b8;font-size:12px;word-break:break-all;">Or copy: ${escapeHtml(resetUrl)}</p>
   <p style="color:#dc2626;font-size:13px;">If you didn't request this, ignore this email. Your password won't change.</p>`
);

/**
 * Leave-request email sent to the employee's manager.
 *
 * Required context fields (per product spec):
 *   - empName      Employee name
 *   - empId        Employee ID
 *   - blockName    Assigned block (may be null → shown as "—")
 *   - reason       Leave reason (user-supplied text)
 *   - dayCount     Number of days being requested
 *   - dateRange    "YYYY-MM-DD" or "YYYY-MM-DD to YYYY-MM-DD"
 *   - leaveType    "Sick Leave" | "Casual Leave" | "Half Day" | "Emergency Leave"
 *   - lastLeave    { type, date, status } of the employee's most recent
 *                  approved leave, or null if they've never taken one.
 *   - managerName  Manager's name (greeting)
 */
const leaveRequestEmailHtml = ({
  managerName, empName, empId, blockName, leaveType, reason,
  dayCount, dateRange, lastLeave,
}) => {
  const lastLeaveCell = lastLeave
    ? `${escapeHtml(lastLeave.type || 'Leave')} on <strong>${fmtDate(lastLeave.date)}</strong>
       <span style="color:#64748b;">(${escapeHtml(lastLeave.status || 'Approved')})</span>`
    : `<span style="color:#64748b;">No previous approved leave on record</span>`;

  return emailLayout(
    `${escapeHtml(leaveType)} Request`,
    `<p style="color:#475569;font-size:14px;line-height:1.6;">
       Hi <strong>${escapeHtml(managerName || 'Manager')}</strong>,
     </p>
     <p style="color:#475569;font-size:14px;line-height:1.6;">
       <strong>${escapeHtml(empName)}</strong> has submitted a
       <strong>${escapeHtml(leaveType)}</strong> request. Details below —
       please review on the AMS Manager Dashboard.
     </p>
     <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:16px 0;">
       ${row('Employee Name', `<strong>${escapeHtml(empName)}</strong>`)}
       ${row('Employee ID',   escapeHtml(empId))}
       ${row('Block',         escapeHtml(blockName || '—'))}
       ${row('Leave Type',    escapeHtml(leaveType))}
       ${row('Number of Days',`<strong>${escapeHtml(String(dayCount))}</strong> day${String(dayCount) === '1' ? '' : 's'}`)}
       ${row('Date / Range',  escapeHtml(dateRange))}
       ${row('Reason',        escapeHtml(reason))}
       ${row('Last Leave Taken', lastLeaveCell)}
     </table>
     <p style="color:#94a3b8;font-size:12px;">
       Approve or reject this request in the Manager Queue of BRP AMS.
     </p>`
  );
};

/**
 * Re-application email (employee re-submits attendance after rejection).
 */
const reapplyEmailHtml = ({ managerName, empName, empId, date, reason, docCount }) => emailLayout(
  'Attendance Re-application',
  `<p style="color:#475569;font-size:14px;line-height:1.6;">
     Hi <strong>${escapeHtml(managerName || 'Manager')}</strong>,
   </p>
   <p style="color:#475569;font-size:14px;line-height:1.6;">
     <strong>${escapeHtml(empName)}</strong> (ID: ${escapeHtml(empId)}) has
     re-submitted their attendance for <strong>${fmtDate(date)}</strong> after rejection.
   </p>
   <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:16px 0;">
     ${row('Employee',       `<strong>${escapeHtml(empName)}</strong> (${escapeHtml(empId)})`)}
     ${row('Date',           fmtDate(date))}
     ${row('Re-apply Reason',escapeHtml(reason))}
     ${row('Supporting Docs',`${Number(docCount) || 0} file(s) attached`)}
   </table>
   <p style="color:#94a3b8;font-size:12px;">
     Review this in the AMS Manager Dashboard.
   </p>`
);

module.exports = {
  emailLayout,
  firstTimePasswordEmailHtml,
  passwordResetEmailHtml,
  leaveRequestEmailHtml,
  reapplyEmailHtml,
};
