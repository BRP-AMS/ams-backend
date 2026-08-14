const express  = require('express');
const router   = express.Router();
const { User, AttendanceRecord } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const guard = [authenticate, authorize('department_portal', 'super_admin')];

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getDateRangeIST(days) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [y, m, d] = todayStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(base);
    dt.setUTCDate(dt.getUTCDate() - i);
    result.push(dt.toISOString().slice(0, 10));
  }
  return result;
}

function buildDateRange(from, to) {
  const result = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to   + 'T00:00:00Z');
  while (cur <= end && result.length <= 90) {
    result.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

function pct(count, total) {
  return total > 0 ? parseFloat((count / total * 100).toFixed(1)) : 0;
}

function locationStatus(p) {
  return p >= 85 ? 'Good' : p >= 70 ? 'Average' : 'Poor';
}

// Classify a single attendance record into real app states
function getState(r) {
  if (!r) return { checkedIn: false, checkedOut: false, onLeave: false };
  if (r.duty_type === 'Leave' && r.leave_status === 'Approved')
    return { checkedIn: false, checkedOut: false, onLeave: true };
  if (r.leave_type != null && r.leave_status === 'Approved')
    return { checkedIn: false, checkedOut: false, onLeave: true };
  const checkedIn  = r.checkin_time  != null;
  const checkedOut = r.checkout_time != null && checkedIn;
  return { checkedIn, checkedOut, onLeave: false };
}

// Build record lookup keyed by User _id for a given date.
// AttendanceRecord.emp_id stores User._id (ObjectId string), NOT the emp_id field.
async function fetchRecordMap(userIds, date) {
  const [records, leaves] = await Promise.all([
    // Same-day records (check-in/out or same-day leave)
    AttendanceRecord
      .find({ emp_id: { $in: userIds }, date }, 'emp_id checkin_time checkout_time leave_type leave_status duty_type')
      .lean(),
    // Multi-day approved leaves spanning today
    AttendanceRecord
      .find({
        emp_id:       { $in: userIds },
        duty_type:    'Leave',
        leave_status: 'Approved',
        date:         { $lte: date },
        $or: [{ end_date: null }, { end_date: { $gte: date } }],
      }, 'emp_id leave_type leave_status duty_type')
      .lean(),
  ]);

  const map = {};
  for (const r of records) map[String(r.emp_id)] = r;
  // Multi-day leaves fill in for employees with no same-day record
  for (const r of leaves) {
    const key = String(r.emp_id);
    if (!map[key]) map[key] = { ...r, leave_status: 'Approved' };
  }
  return map;
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const toHHMM = (mins) => {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
};

// ── GET /api/dept-dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD ────────────

router.get('/summary', guard, async (req, res) => {
  try {
    const today = todayIST();
    const from = isDate(req.query.from) ? req.query.from : (isDate(req.query.date) ? req.query.date : today);
    const to   = isDate(req.query.to)   ? req.query.to   : from;

    const employees = await User.find({ role: 'employee', is_active: { $ne: 0 } }, '_id').lean();
    const totalEmployees = employees.length;
    const userIds = employees.map(e => String(e._id));

    let checkedIn = 0, checkedOut = 0, onLeave = 0;
    let totalCiMins = 0, ciCount = 0, totalCoMins = 0, coCount = 0;

    if (from === to) {
      // Single day — use full leave-spanning logic
      const recordMap = await fetchRecordMap(userIds, from);
      for (const id of userIds) {
        const s = getState(recordMap[id]);
        if (s.onLeave)         onLeave++;
        else if (s.checkedOut) { checkedIn++; checkedOut++; }
        else if (s.checkedIn)  checkedIn++;
        const r = recordMap[id];
        if (r?.checkin_time)  { const [h, m] = r.checkin_time.split(':').map(Number);  totalCiMins += h * 60 + (m || 0); ciCount++; }
        if (r?.checkout_time) { const [h, m] = r.checkout_time.split(':').map(Number); totalCoMins += h * 60 + (m || 0); coCount++; }
      }
    } else {
      // Date range — count distinct employees who attended at least once
      const records = await AttendanceRecord.find(
        { emp_id: { $in: userIds }, date: { $gte: from, $lte: to } },
        'emp_id checkin_time checkout_time leave_type leave_status duty_type'
      ).lean();
      const attendedSet = new Set(), checkoutSet = new Set(), leaveSet = new Set();
      for (const r of records) {
        const uid = String(r.emp_id);
        const s = getState(r);
        if (s.onLeave)   leaveSet.add(uid);
        if (s.checkedIn) { attendedSet.add(uid); if (r.checkin_time)  { const [h, m] = r.checkin_time.split(':').map(Number);  totalCiMins += h*60+(m||0); ciCount++; } }
        if (s.checkedOut) { checkoutSet.add(uid); if (r.checkout_time) { const [h, m] = r.checkout_time.split(':').map(Number); totalCoMins += h*60+(m||0); coCount++; } }
      }
      checkedIn  = attendedSet.size;
      checkedOut = checkoutSet.size;
      onLeave    = leaveSet.size;
    }

    const notCheckedIn = Math.max(0, totalEmployees - checkedIn - onLeave);
    return res.json({
      success: true,
      data: {
        totalEmployees, checkedIn, checkedOut, onLeave, notCheckedIn,
        checkedInPct:    pct(checkedIn,    totalEmployees),
        checkedOutPct:   pct(checkedOut,   totalEmployees),
        onLeavePct:      pct(onLeave,      totalEmployees),
        notCheckedInPct: pct(notCheckedIn, totalEmployees),
        avgCheckinTime:  ciCount > 0 ? toHHMM(totalCiMins / ciCount)  : null,
        avgCheckoutTime: coCount > 0 ? toHHMM(totalCoMins / coCount) : null,
      },
    });
  } catch {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/dept-dashboard/trend?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────

router.get('/trend', guard, async (req, res) => {
  try {
    const isValidDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    let dateRange;
    if (isValidDate(req.query.from) && isValidDate(req.query.to)) {
      dateRange = buildDateRange(req.query.from, req.query.to);
    } else {
      const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 90));
      dateRange = getDateRangeIST(days);
    }
    const startDate = dateRange[0];
    const endDate   = dateRange[dateRange.length - 1];

    const totalEmployees = await User.countDocuments({ role: 'employee', is_active: { $ne: 0 } });

    // Count employees who checked in per day (have a checkin_time, no leave)
    const agg = await AttendanceRecord.aggregate([
      {
        $match: {
          date:        { $gte: startDate, $lte: endDate },
          checkin_time: { $ne: null },
          $or: [{ leave_type: null }, { leave_status: { $ne: 'Approved' } }],
        },
      },
      {
        $group: {
          _id:         '$date',
          checkedIn:   { $sum: 1 },
          checkedOut:  { $sum: { $cond: [{ $ne: ['$checkout_time', null] }, 1, 0] } },
        },
      },
    ]);

    const aggMap = {};
    for (const item of agg) aggMap[item._id] = item;

    const data = dateRange.map(date => {
      const row = aggMap[date] || { checkedIn: 0, checkedOut: 0 };
      return {
        date,
        totalEmployees,
        checkedIn:  row.checkedIn,
        checkedOut: row.checkedOut,
        pct:        pct(row.checkedIn, totalEmployees),
      };
    });

    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/dept-dashboard/by-district?from=YYYY-MM-DD&to=YYYY-MM-DD ────────

router.get('/by-district', guard, async (req, res) => {
  try {
    const today = todayIST();
    const from = isDate(req.query.from) ? req.query.from : (isDate(req.query.date) ? req.query.date : today);
    const to   = isDate(req.query.to)   ? req.query.to   : from;

    const employees = await User
      .find({ role: 'employee', is_active: { $ne: 0 } }, '_id assigned_district')
      .lean();

    const districtMap = {};
    for (const emp of employees) {
      const district = emp.assigned_district || 'Unassigned';
      if (!districtMap[district]) districtMap[district] = [];
      districtMap[district].push(String(emp._id));
    }

    const allUserIds = employees.map(e => String(e._id));

    let attendedSet = new Set(), checkoutSet = new Set(), leaveSet = new Set();

    if (from === to) {
      const recordMap = await fetchRecordMap(allUserIds, from);
      for (const id of allUserIds) {
        const s = getState(recordMap[id]);
        if (s.onLeave)   leaveSet.add(id);
        if (s.checkedIn) attendedSet.add(id);
        if (s.checkedOut) checkoutSet.add(id);
      }
    } else {
      const records = await AttendanceRecord.find(
        { emp_id: { $in: allUserIds }, date: { $gte: from, $lte: to } },
        'emp_id checkin_time checkout_time leave_type leave_status duty_type'
      ).lean();
      for (const r of records) {
        const uid = String(r.emp_id);
        const s = getState(r);
        if (s.onLeave)   leaveSet.add(uid);
        if (s.checkedIn) attendedSet.add(uid);
        if (s.checkedOut) checkoutSet.add(uid);
      }
    }

    const data = Object.entries(districtMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([district, empIds]) => {
        const total = empIds.length;
        let checkedIn = 0, checkedOut = 0, onLeave = 0;
        for (const id of empIds) {
          if (leaveSet.has(id))    onLeave++;
          if (attendedSet.has(id)) checkedIn++;
          if (checkoutSet.has(id)) checkedOut++;
        }
        const notCheckedIn = Math.max(0, total - checkedIn - onLeave);
        const p = pct(checkedIn, total);
        return { district, total, checkedIn, checkedOut, onLeave, notCheckedIn, pct: p, status: locationStatus(p) };
      });

    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/dept-dashboard/employees-by-district?district=X&from=&to= ───────

router.get('/employees-by-district', guard, async (req, res) => {
  try {
    const today    = todayIST();
    const from     = isDate(req.query.from) ? req.query.from : (isDate(req.query.date) ? req.query.date : today);
    const to       = isDate(req.query.to)   ? req.query.to   : from;
    const district = req.query.district || '';

    const query = { role: 'employee', is_active: { $ne: 0 } };
    if (district === 'Unassigned') {
      query.$or = [{ assigned_district: null }, { assigned_district: '' }];
    } else if (district) {
      query.assigned_district = district;
    }

    const employees = await User.find(query, '_id emp_id name').lean();
    const userIds   = employees.map(e => String(e._id));

    let data;
    if (from === to) {
      const recordMap = await fetchRecordMap(userIds, from);
      data = employees
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map(emp => {
          const r = recordMap[String(emp._id)] || {};
          return { name: emp.name, emp_id: emp.emp_id, checkin_time: r.checkin_time || null, checkout_time: r.checkout_time || null };
        });
    } else {
      const records = await AttendanceRecord.find(
        { emp_id: { $in: userIds }, date: { $gte: from, $lte: to } },
        'emp_id checkin_time date'
      ).lean();
      // count days attended per employee
      const daysMap = {};
      for (const r of records) {
        if (!r.checkin_time) continue;
        const uid = String(r.emp_id);
        if (!daysMap[uid]) daysMap[uid] = new Set();
        daysMap[uid].add(r.date);
      }
      const totalDays = buildDateRange(from, to).length;
      data = employees
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map(emp => {
          const uid = String(emp._id);
          const days = daysMap[uid] ? daysMap[uid].size : 0;
          return { name: emp.name, emp_id: emp.emp_id, days_attended: days, total_days: totalDays };
        });
    }

    return res.json({ success: true, data, isRange: from !== to });
  } catch {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/dept-dashboard/export ───────────────────────────────────────────

router.get('/export', guard, async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayIST();

    const employees = await User
      .find({ role: 'employee', is_active: { $ne: 0 } }, '_id assigned_district')
      .lean();
    const allUserIds = employees.map(e => String(e._id));
    const recordMap  = await fetchRecordMap(allUserIds, date);

    // ── Overall summary ───────────────────────────────────────────────────────
    const total = employees.length;
    let checkedIn = 0, checkedOut = 0, onLeave = 0;
    for (const id of allUserIds) {
      const s = getState(recordMap[id]);
      if (s.onLeave)         onLeave++;
      else if (s.checkedOut) { checkedIn++; checkedOut++; }
      else if (s.checkedIn)  { checkedIn++; }
    }
    const notCheckedIn = total - checkedIn - onLeave;
    const attPct = pct(checkedIn, total);

    // ── District breakdown ────────────────────────────────────────────────────
    const districtMap = {};
    for (const emp of employees) {
      const d = emp.assigned_district || 'Unassigned';
      if (!districtMap[d]) districtMap[d] = [];
      districtMap[d].push(String(emp._id));
    }
    const districtRows = Object.entries(districtMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([district, ids]) => {
        const dt = ids.length;
        let dIn = 0, dOut = 0, dLv = 0;
        for (const id of ids) {
          const s = getState(recordMap[id]);
          if (s.onLeave)         dLv++;
          else if (s.checkedOut) { dIn++; dOut++; }
          else if (s.checkedIn)  { dIn++; }
        }
        const dNotIn = dt - dIn - dLv;
        const dp = pct(dIn, dt);
        return [district, dt, dIn, dOut, dLv, dNotIn, `${dp}%`, locationStatus(dp)];
      });

    // ── Alerts ────────────────────────────────────────────────────────────────
    const poorDistricts = districtRows.filter(r => r[7] === 'Poor');

    // ── Date formatting ───────────────────────────────────────────────────────
    const [yr, mo, dy] = date.split('-').map(Number);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateFmt = `${String(dy).padStart(2,'0')}-${MONTHS[mo-1]}-${yr}`;

    const q   = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const row = (...args) => args.map(q).join(',');

    const lines = [
      row('ATTENDANCE MANAGEMENT DASHBOARD', '', '', '', '', '', ''),
      row(`Date: ${dateFmt}`, '', 'Department: All', '', 'Location: All', '', ''),
      '',
      row('SUMMARY', '', '', '', '', '', ''),
      row('TOTAL', 'PRESENT', 'CHECKED OUT', 'ON LEAVE', 'ABSENT', 'ATTENDANCE %', ''),
      row(total, checkedIn, checkedOut, onLeave, notCheckedIn, `${attPct}%`, ''),
      '',
      row('DISTRICT-WISE ATTENDANCE', '', '', '', '', '', ''),
      row('District', 'Total', 'Checked In', 'Checked Out', 'On Leave', 'Not Checked In', 'Attendance %', 'Status'),
      ...districtRows.map(r => row(...r)),
      '',
      row('ATTENTION REQUIRED', '', '', '', '', '', ''),
      ...(poorDistricts.length > 0
        ? poorDistricts.map(r => row(`Low attendance in ${r[0]} — ${r[6]}`, '', '', '', '', '', ''))
        : []),
      ...(notCheckedIn > 0
        ? [row(`${notCheckedIn} employee${notCheckedIn !== 1 ? 's' : ''} not yet checked in today`, '', '', '', '', '', '')]
        : []),
      ...((poorDistricts.length === 0 && notCheckedIn === 0)
        ? [row('No critical alerts', '', '', '', '', '', '')]
        : []),
    ];

    const csv      = lines.join('\r\n');
    const filename = `attendance-report-${date}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
