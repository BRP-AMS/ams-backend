// Shared leave_balance guardrails — used by attendance.js (auto-deduct/refund
// on leave apply/reject/cancel) and users.js (manual/bulk/Excel adjustment)
// so every write path enforces the same rule: whole days only, 0–24.
// ('Half Day' has been removed as a leave type, so every leave now costs a
// full day — balances are whole numbers only, no more .5 steps.)
const LEAVE_BALANCE_MAX = 24;

// Rounds to the nearest whole day so floating-point drift never leaves an
// odd decimal on a balance. No upper bound — used for per-request day counts
// (paid_days, lop_days) too, which aren't themselves balances and can
// legitimately exceed 24 (e.g. a long unpaid Planned Leave). Name kept as
// roundHalfDay for compatibility with existing call sites/imports.
const roundHalfDay = (n) => {
  const rounded = Math.round(Number(n));
  return Number.isFinite(rounded) ? Math.max(0, rounded) : 0;
};

// The actual leave_balance guardrail — whole days, clamped to [0, 24].
const clampLeaveBalance = (n) => Math.min(LEAVE_BALANCE_MAX, roundHalfDay(n));

module.exports = { LEAVE_BALANCE_MAX, clampLeaveBalance, roundHalfDay };
