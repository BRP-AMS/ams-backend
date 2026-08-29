// Shared time-display helper — the app stores check-in/check-out times as a
// plain 24h "HH:MM" string, but every human-facing surface (screens, emails,
// exports) shows "h:MM AM/PM" instead. Used wherever a raw stored time string
// needs to go into user-facing text (email bodies, export cells) rather than
// through Date.toLocaleTimeString({hour12:true}), which only works on actual
// Date objects.
const fmt12h = (hhmm) => {
  const [hStr, mStr] = String(hhmm || '').split(':');
  const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
};

module.exports = { fmt12h };
