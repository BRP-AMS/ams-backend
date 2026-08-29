// Shared leave_balance guardrails — used by attendance.js (auto-deduct/refund
// on leave apply/reject/cancel) and users.js (manual/bulk/Excel adjustment)
// so every write path enforces the same rule: half-day steps only, 0–24.
const LEAVE_BALANCE_MAX = 24;

// Rounds to the nearest 0.5 so Half Day's 0.5 deductions/refunds never drift
// into odd decimals from floating-point math. No upper bound — used for
// per-request day counts (paid_days, lop_days), which aren't themselves
// balances and can legitimately exceed 24 (e.g. a long unpaid Planned Leave).
const roundHalfDay = (n) => {
  const rounded = Math.round(Number(n) * 2) / 2;
  return Number.isFinite(rounded) ? Math.max(0, rounded) : 0;
};

// The actual leave_balance guardrail — half-day steps, clamped to [0, 24].
const clampLeaveBalance = (n) => Math.min(LEAVE_BALANCE_MAX, roundHalfDay(n));

module.exports = { LEAVE_BALANCE_MAX, clampLeaveBalance, roundHalfDay };
