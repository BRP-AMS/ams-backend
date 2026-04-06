// const express      = require('express');
// const router       = express.Router();
// const XLSX         = require('xlsx');
// const PDFDocument  = require('pdfkit');
// const { AttendanceRecord } = require('../models/database');
// const { authenticate, authorize } = require('../middleware/auth');

// // ── GET /api/reports/export ──────────────────────────────────────────────
// router.get('/export', authenticate, authorize('manager', 'admin', 'hr','employee'), async (req, res) => {
//   try {
//     const { format = 'excel', startDate, endDate, department, status, empId } = req.query;

//     // Build base match filter
//     const matchFilter = {};
//     if (req.user.role === 'manager') matchFilter.manager_id = req.user.id;
//     if (startDate)  matchFilter.date   = { ...matchFilter.date,   $gte: startDate };
//     if (endDate)    matchFilter.date   = { ...matchFilter.date,   $lte: endDate   };
//     if (status)     matchFilter.status = status;
//     if (empId)      matchFilter.emp_id = empId;

//     const MAX_EXPORT_ROWS = 5000;

//     // Build aggregation pipeline (JOIN users and manager)
//     const pipeline = [
//       { $match: matchFilter },
//       { $lookup: { from: 'users', localField: 'emp_id',     foreignField: '_id', as: 'emp'     } },
//       { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
//       { $addFields: {
//           emp_id_code:     { $arrayElemAt: ['$emp.emp_id',     0] },
//           employee_name:   { $arrayElemAt: ['$emp.name',       0] },
//           dept:            { $arrayElemAt: ['$emp.department',  0] },
//           manager_name:    { $arrayElemAt: ['$manager.name',   0] },
//       }},
//       { $project: { emp: 0, manager: 0 } },
//       { $sort: { date: -1, employee_name: 1 } },
//       { $limit: MAX_EXPORT_ROWS },
//     ];

//     // Admin can filter by department (requires post-lookup filter)
//     if (department && req.user.role === 'admin') {
//       pipeline.splice(4, 0, { $match: { dept: department } });
//     }

//     const records = await AttendanceRecord.aggregate(pipeline);

//     if (format === 'excel') {
//       const wsData = [
//         ['Date', 'Emp ID', 'Employee Name', 'Department', 'Duty Type', 'Sector', 'Check-In', 'Check-Out', 'Location', 'Description', 'Status', 'Manager', 'Remark', 'Actioned At'],
//         ...records.map(r => [
//           r.date, r.emp_id_code, r.employee_name, r.dept,
//           r.duty_type, r.sector || '', r.checkin_time || '', r.checkout_time || '',
//           r.location_address || '', r.description || '', r.status,
//           r.manager_name || '', r.manager_remark || '', r.actioned_at || '',
//         ])
//       ];
//       const ws = XLSX.utils.aoa_to_sheet(wsData);
//       ws['!cols'] = wsData[0].map((_, i) => ({ wch: [12, 10, 20, 15, 12, 10, 10, 10, 25, 30, 12, 20, 25, 18][i] }));
//       const wb = XLSX.utils.book_new();
//       XLSX.utils.book_append_sheet(wb, ws, 'Attendance Report');
//       const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
//       res.setHeader('Content-Disposition', `attachment; filename="attendance_report_${Date.now()}.xlsx"`);
//       res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
//       return res.send(buf);
//     }

//     if (format === 'pdf') {
//       const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
//       res.setHeader('Content-Disposition', `attachment; filename="attendance_report_${Date.now()}.pdf"`);
//       res.setHeader('Content-Type', 'application/pdf');
//       doc.pipe(res);

//       // Header
//       doc.fontSize(18).fillColor('#0D9488').text('BRP Attendance Report', { align: 'center' });
//       doc.fontSize(10).fillColor('#64748B').text(`Generated: ${new Date().toLocaleString('en-IN')} | Records: ${records.length}`, { align: 'center' });
//       doc.moveDown(0.5);

//       // Table header
//       const cols    = [60, 50, 110, 85, 70, 55, 50, 50, 80, 70];
//       const headers = ['Date', 'Emp ID', 'Name', 'Department', 'Duty Type', 'Sector', 'In', 'Out', 'Status', 'Manager'];
//       let y = doc.y + 5;
//       doc.rect(40, y, 760, 18).fill('#0D9488');
//       doc.fillColor('#FFFFFF').fontSize(8);
//       let x = 45;
//       headers.forEach((h, i) => { doc.text(h, x, y + 4, { width: cols[i] }); x += cols[i]; });
//       y += 18;

//       records.slice(0, 100).forEach((r, idx) => {
//         if (y > 520) { doc.addPage(); y = 40; }
//         const bg = idx % 2 === 0 ? '#F8FAFC' : '#FFFFFF';
//         doc.rect(40, y, 760, 16).fill(bg);
//         const statusColor = { Approved: '#16A34A', Pending: '#D97706', Rejected: '#DC2626' }[r.status] || '#64748B';
//         doc.fillColor('#334155').fontSize(7.5);
//         x = 45;
//         [r.date, r.emp_id_code, r.employee_name, r.dept, r.duty_type, r.sector || '-', r.checkin_time || '-', r.checkout_time || '-', '', r.manager_name || '-'].forEach((val, i) => {
//           if (i === 8) {
//             doc.fillColor(statusColor).text(r.status, x, y + 3, { width: cols[i] });
//             doc.fillColor('#334155');
//           } else {
//             doc.text(val, x, y + 3, { width: cols[i] });
//           }
//           x += cols[i];
//         });
//         y += 16;
//       });

//       doc.end();
//       return;
//     }

//     res.status(400).json({ success: false, message: 'Invalid format. Use excel or pdf' });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });

// // ── GET /api/reports/dashboard-stats ────────────────────────────────────
// router.get('/dashboard-stats', authenticate, async (req, res) => {
//   try {
//     const today     = new Date().toISOString().split('T')[0];
//     const thisMonth = today.substring(0, 7);

//     const empFilter = {};
//     if (req.user.role === 'employee') {
//       empFilter.emp_id    = req.user.id;
//     } else if (req.user.role === 'manager') {
//       empFilter.manager_id = req.user.id;
//     }

//     // Use a range instead of LIKE so the date index is used
//     const monthStart = `${thisMonth}-01`;
//     const [year, month] = thisMonth.split('-').map(Number);
//     const nextMonth = month === 12
//       ? `${year + 1}-01-01`
//       : `${year}-${String(month + 1).padStart(2, '0')}-01`;

//     const monthlyResult = await AttendanceRecord.aggregate([
//       { $match: { date: { $gte: monthStart, $lt: nextMonth }, ...empFilter } },
//       { $group: {
//         _id:     null,
//         total:   { $sum: 1 },
//         approved:{ $sum: { $cond: [{ $eq: ['$status',    'Approved']   }, 1, 0] } },
//         pending: { $sum: { $cond: [{ $eq: ['$status',    'Pending']    }, 1, 0] } },
//         rejected:{ $sum: { $cond: [{ $eq: ['$status',    'Rejected']   }, 1, 0] } },
//         on_duty: { $sum: { $cond: [{ $eq: ['$duty_type', 'On Duty']    }, 1, 0] } },
//       }},
//       { $project: { _id: 0 } },
//     ]);
//     const monthly = monthlyResult[0] || { total: 0, approved: 0, pending: 0, rejected: 0, on_duty: 0 };

//     // Last 7 days trend
//     const sevenDaysAgo = new Date();
//     sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
//     const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

//     const trend = await AttendanceRecord.aggregate([
//       { $match: { date: { $gte: sevenDaysAgoStr }, ...empFilter } },
//       { $group: {
//         _id:      '$date',
//         count:    { $sum: 1 },
//         approved: { $sum: { $cond: [{ $eq: ['$status', 'Approved'] }, 1, 0] } },
//       }},
//       { $project: { _id: 0, date: '$_id', count: 1, approved: 1 } },
//       { $sort: { date: 1 } },
//     ]);

//     res.json({ success: true, data: { monthly, trend } });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });

// module.exports = router;


const express      = require('express');
const router       = express.Router();
const XLSX         = require('xlsx');
const PDFDocument  = require('pdfkit');
const { AttendanceRecord } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');
const mongoose     = require('mongoose');

// ── Helper: safe ObjectId conversion ─────────────────────────────────────
const toObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch (e) {
    return id; // fallback to raw string if invalid
  }
};

// ── GET /api/reports/export ──────────────────────────────────────────────
router.get('/export', authenticate, authorize('manager', 'admin', 'hr', 'employee'), async (req, res) => {
  try {
    console.log('Export request by:', req.user.role, '| ID:', req.user.id, '| Query:', req.query);

    const { format = 'excel', startDate, endDate, department, status, empId } = req.query;

    // Build base match filter
    const matchFilter = {};

    // ── Role-based filtering ──────────────────────────────────────────
    if (req.user.role === 'employee') {
      // Employee can ONLY see their own records
      matchFilter.emp_id = toObjectId(req.user.id);
      console.log('Employee filter applied — emp_id:', matchFilter.emp_id);
    } else if (req.user.role === 'manager') {
      matchFilter.manager_id = toObjectId(req.user.id);
    } else if (empId) {
      // Admin/HR can optionally filter by a specific employee
      matchFilter.emp_id = toObjectId(empId);
    }

    if (startDate) matchFilter.date = { ...matchFilter.date, $gte: startDate };
    if (endDate)   matchFilter.date = { ...matchFilter.date, $lte: endDate   };
    if (status)    matchFilter.status = status;

    console.log('Final matchFilter:', JSON.stringify(matchFilter));

    const MAX_EXPORT_ROWS = 5000;

    // Build aggregation pipeline
    const pipeline = [
      { $match: matchFilter },
      { $lookup: { from: 'users', localField: 'emp_id',     foreignField: '_id', as: 'emp'     } },
      { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
      { $addFields: {
          emp_id_code:   { $arrayElemAt: ['$emp.emp_id',    0] },
          employee_name: { $arrayElemAt: ['$emp.name',      0] },
          dept:          { $arrayElemAt: ['$emp.department', 0] },
          manager_name:  { $arrayElemAt: ['$manager.name',  0] },
      }},
      { $project: { emp: 0, manager: 0 } },
      { $sort: { date: -1, employee_name: 1 } },
      { $limit: MAX_EXPORT_ROWS },
    ];

    // Admin/HR can filter by department (post-lookup)
    if (department && ['admin', 'hr'].includes(req.user.role)) {
      pipeline.splice(4, 0, { $match: { dept: department } });
    }

    const records = await AttendanceRecord.aggregate(pipeline);
    console.log('Records found:', records.length);

    // ── Excel Export ─────────────────────────────────────────────────
    if (format === 'excel') {
      // Build day range
      const rangeStart = startDate ? new Date(startDate + 'T00:00:00') : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const rangeEnd   = endDate   ? new Date(endDate   + 'T00:00:00') : new Date();
      const days = [];
      for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));

      // Group records by employee
      const empMap = {};
      records.forEach(r => {
        const key = String(r.emp_id);
        if (!empMap[key]) empMap[key] = { empCode: r.emp_id_code || '', empName: r.employee_name || '', byDate: {} };
        empMap[key].byDate[r.date] = r;
      });

      // Attendance code per day
      const getCode = (dayObj, rec) => {
        if (!rec) return dayObj.getDay() === 0 ? 'WO' : 'O';
        if (rec.duty_type === 'Office Duty') return 'P';
        if (rec.duty_type === 'On Duty')     return 'OD';
        if (rec.duty_type === 'Leave')       return 'L';
        return 'P';
      };

      const ord = n => n + ([,'st','nd','rd'][((n%100)-10)%90>>3?n%10:0]||'th');
      const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const dateLabel = `for the month of ${ord(rangeStart.getDate())} ${MONTHS[rangeStart.getMonth()]}- ${rangeStart.getFullYear()} To ${ord(rangeEnd.getDate())} ${MONTHS[rangeEnd.getMonth()]} ${rangeEnd.getFullYear()}`;

      const isSingleEmp = req.user.role === 'employee' || !!matchFilter.emp_id;
      const employees   = Object.values(empMap);

      const wsData = [
        [null, null, 'Attendance details of BRP'],
        [null, null, dateLabel],
        [null, null, 'Location Name: Tripura', null, null, null, null, null, null, null, null, 'Project Name: Block Resource Person'],
        [null, 'Emp code', 'Employee Name', ...days.map(d => d.getDate())],
      ];

      employees.forEach(emp => {
        wsData.push([null, emp.empCode, emp.empName,
          ...days.map(d => getCode(d, emp.byDate[d.toISOString().split('T')[0]]))]);
      });

      // Summary
      wsData.push([]);
      if (isSingleEmp) {
        wsData.push([null, null, 'Self  Summary report']);
        const emp = employees[0];
        let workingDays = 0, present = 0, leaves = 0, holidays = 0, weekoffs = 0;
        if (emp) {
          days.forEach(d => {
            const code = getCode(d, emp.byDate[d.toISOString().split('T')[0]]);
            if (code === 'WO') weekoffs++;
            else if (code === 'H') holidays++;
            else { workingDays++; if (code === 'P' || code === 'OD') present++; else if (code === 'L') leaves++; }
          });
        }
        wsData.push([null, null, 'No of Working days',         workingDays]);
        wsData.push([null, null, 'No of Present / worked (P)', present]);
        wsData.push([null, null, 'No of Leaves (L)',           leaves]);
        wsData.push([null, null, 'No of Holidays (H)',         holidays]);
        wsData.push([null, null, 'No of Weekoff (WO)',         weekoffs]);
      } else {
        wsData.push([null, null, 'Total Summary']);
        wsData.push([null, null, 'No of Working days', days.filter(d => d.getDay() !== 0).length]);
        wsData.push([null, null, 'No of Holidays (H)', 0]);
        wsData.push([null, null, 'No of Weekoff (WO)',  days.filter(d => d.getDay() === 0).length]);
        wsData.push([null, null, 'No of present/ Worked']);
        employees.forEach(emp => {
          const present = days.filter(d => { const c = getCode(d, emp.byDate[d.toISOString().split('T')[0]]); return c === 'P' || c === 'OD'; }).length;
          wsData.push([null, null, emp.empName, present]);
        });
      }

      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = [{ wch: 2 }, { wch: 10 }, { wch: 22 }, ...days.map(() => ({ wch: 4 }))];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, isSingleEmp ? 'Self report' : 'All emp Reports');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
      res.setHeader('Content-Disposition', `attachment; filename="attendance_report_${Date.now()}.xlsx"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(buf);
    }

    // ── PDF Export ───────────────────────────────────────────────────
    if (format === 'pdf') {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      res.setHeader('Content-Disposition', `attachment; filename="attendance_report_${Date.now()}.pdf"`);
      res.setHeader('Content-Type', 'application/pdf');
      doc.pipe(res);

      // Title
      doc.fontSize(18).fillColor('#0D9488').text('BRP Attendance Report', { align: 'center' });
      doc.fontSize(10).fillColor('#64748B').text(
        `Generated: ${new Date().toLocaleString('en-IN')} | Records: ${records.length}`,
        { align: 'center' }
      );
      doc.moveDown(0.5);

      // Table header
      const cols    = [60, 50, 110, 85, 70, 55, 50, 50, 80, 70];
      const headers = ['Date', 'Emp ID', 'Name', 'Department', 'Duty Type', 'Sector', 'In', 'Out', 'Status', 'Manager'];
      let y = doc.y + 5;
      doc.rect(40, y, 760, 18).fill('#0D9488');
      doc.fillColor('#FFFFFF').fontSize(8);
      let x = 45;
      headers.forEach((h, i) => { doc.text(h, x, y + 4, { width: cols[i] }); x += cols[i]; });
      y += 18;

      records.slice(0, 100).forEach((r, idx) => {
        if (y > 520) { doc.addPage(); y = 40; }
        const bg = idx % 2 === 0 ? '#F8FAFC' : '#FFFFFF';
        doc.rect(40, y, 760, 16).fill(bg);
        const statusColor = { Approved: '#16A34A', Pending: '#D97706', Rejected: '#DC2626' }[r.status] || '#64748B';
        doc.fillColor('#334155').fontSize(7.5);
        x = 45;
        [
          r.date, r.emp_id_code, r.employee_name, r.dept,
          r.duty_type, r.sector || '-', r.checkin_time || '-', r.checkout_time || '-',
          '', r.manager_name || '-'
        ].forEach((val, i) => {
          if (i === 8) {
            doc.fillColor(statusColor).text(r.status, x, y + 3, { width: cols[i] });
            doc.fillColor('#334155');
          } else {
            doc.text(String(val || '-'), x, y + 3, { width: cols[i] });
          }
          x += cols[i];
        });
        y += 16;
      });

      doc.end();
      return;
    }

    res.status(400).json({ success: false, message: 'Invalid format. Use excel or pdf' });

  } catch (err) {
    console.error('Export error full:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// ── GET /api/reports/dashboard-stats ────────────────────────────────────
router.get('/dashboard-stats', authenticate, async (req, res) => {
  try {
    console.log('Dashboard stats request by:', req.user.role, '| ID:', req.user.id);

    const today     = new Date().toISOString().split('T')[0];
    const thisMonth = today.substring(0, 7);

    const empFilter = {};
    if (req.user.role === 'employee') {
      empFilter.emp_id     = toObjectId(req.user.id);
    } else if (req.user.role === 'manager') {
      empFilter.manager_id = toObjectId(req.user.id);
    }

    const monthStart = `${thisMonth}-01`;
    const [year, month] = thisMonth.split('-').map(Number);
    const nextMonth = month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    const monthlyResult = await AttendanceRecord.aggregate([
      { $match: { date: { $gte: monthStart, $lt: nextMonth }, ...empFilter } },
      { $group: {
          _id:      null,
          total:    { $sum: 1 },
          approved: { $sum: { $cond: [{ $eq: ['$status',    'Approved'] }, 1, 0] } },
          pending:  { $sum: { $cond: [{ $eq: ['$status',    'Pending']  }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status',    'Rejected'] }, 1, 0] } },
          on_duty:  { $sum: { $cond: [{ $eq: ['$duty_type', 'On Duty']  }, 1, 0] } },
      }},
      { $project: { _id: 0 } },
    ]);
    const monthly = monthlyResult[0] || { total: 0, approved: 0, pending: 0, rejected: 0, on_duty: 0 };

    // Last 7 days trend
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

    const trend = await AttendanceRecord.aggregate([
      { $match: { date: { $gte: sevenDaysAgoStr }, ...empFilter } },
      { $group: {
          _id:      '$date',
          count:    { $sum: 1 },
          approved: { $sum: { $cond: [{ $eq: ['$status', 'Approved'] }, 1, 0] } },
      }},
      { $project: { _id: 0, date: '$_id', count: 1, approved: 1 } },
      { $sort: { date: 1 } },
    ]);

    res.json({ success: true, data: { monthly, trend } });

  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

module.exports = router;