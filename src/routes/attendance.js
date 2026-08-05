const express        = require('express');
const router         = express.Router();
const multer         = require('multer');
const { uploadFile } = require('../utils/storage');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { AttendanceRecord, User, Notification, AuditLog } = require('../models/database');
const { authenticate, authorize }                         = require('../middleware/auth');
const { sendMail }                                        = require('../utils/mailer');
const path = require('path');

// ── IST helpers ───────────────────────────────────────────────────────────
const istDateStr    = () => new Date().toLocaleDateString('en-CA',  { timeZone: 'Asia/Kolkata' });
const istTimeStr    = () => new Date().toLocaleTimeString('en-GB',  { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).substring(0, 5);
const istMonthStr   = () => new Date().toLocaleDateString('en-CA',  { timeZone: 'Asia/Kolkata' }).substring(0, 7);
const istMonthLabel = () => new Date().toLocaleDateString('en-IN',  { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' });

// ── Multer — selfie images ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    const ext = path.extname(file.originalname).toLowerCase();
    const ok  = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    if (!ok.includes(ext)) return cb(new Error('Invalid file extension'));
    const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    if (map[ext] && map[ext] !== file.mimetype) return cb(new Error('File extension does not match file type'));
    cb(null, true);
  },
});

// ── Multer — reapply supporting documents (images + PDFs + Office docs) ──
const reapplyUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok  = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.xlsx', '.xls'];
    if (!ok.includes(ext)) return cb(new Error('File type not allowed'));
    cb(null, true);
  },
});


// ── Multer — scan documents ───────────────────────────────────────────────
const uploadScan = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'application/pdf'];
    if (!ok.includes(file.mimetype)) return cb(new Error('Only JPG, PNG, WEBP or PDF accepted'));
    cb(null, true);
  },
});

const uploadSignedReport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!ok.includes(file.mimetype)) return cb(new Error('Only JPG, PNG, WEBP or PDF accepted'));
    cb(null, true);
  },
});

// ── Notification helper ───────────────────────────────────────────────────
const notify = async (userId, title, message, type = 'info', recordId = null, link = null) =>
  Notification.create({ _id: uuidv4(), user_id: userId, title, message, type, related_record_id: recordId, link });

// ── Aggregation pipeline helper ───────────────────────────────────────────
const recordListPipeline = (match, sort, skip, limit) => [
  { $match: match },
  { $lookup: { from: 'users', localField: 'emp_id',      foreignField: '_id', as: 'emp'             } },
  { $lookup: { from: 'users', localField: 'manager_id',  foreignField: '_id', as: 'manager'         } },
  { $lookup: { from: 'users', localField: 'actioned_by', foreignField: '_id', as: 'actioned_by_user' } },
  { $addFields: {
    emp_name:          { $arrayElemAt: ['$emp.name',               0] },
    emp_code:          { $arrayElemAt: ['$emp.emp_id',             0] },
    department:        { $arrayElemAt: ['$emp.department',         0] },
    emp_face_photo:    { $arrayElemAt: ['$emp.facePhotoUrl',       0] },
    emp_profile_photo: { $arrayElemAt: ['$emp.profile_photo_path', 0] },
    manager_name:      { $arrayElemAt: ['$manager.name',           0] },
    actioned_by_name:  { $arrayElemAt: ['$actioned_by_user.name',  0] },
  }},
  { $project: { emp: 0, manager: 0, actioned_by_user: 0 } },
  { $sort: sort },
  { $skip: skip },
  { $limit: limit },
];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, startDate, endDate, empId, onlyLeaves } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const match  = {};

    if (req.user.role === 'employee')
      match.emp_id = req.user.id;
    else if (req.user.role === 'manager') {
      if (empId) {
        const emp = await User.findOne({ _id: empId, manager_id: req.user.id }).lean();
        if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });
        match.emp_id = empId;
      } else {
        const teamMembers = await User.find({ manager_id: req.user.id }).select('_id').lean();
        match.emp_id = { $in: teamMembers.map(m => m._id) };
      }
    } else if (['admin', 'hr', 'super_admin'].includes(req.user.role)) {
      if (empId) match.emp_id = empId;
    }

    if (onlyLeaves === 'true') match.leave_type = { $ne: null };

    if (status) {
      const isManagerOrAdmin = ['manager', 'admin', 'hr', 'super_admin'].includes(req.user.role);
      if (status === 'Pending' && isManagerOrAdmin) {
        const todayIST = istDateStr();
        match.$or = [
          { status: 'Pending' },
          { status: 'Draft', date: { $lt: todayIST }, checkin_time: { $ne: null }, checkout_time: null },
        ];
      } else if (onlyLeaves === 'true') {
        match.leave_status = status;
      } else {
        match.status = status;
      }
    }

    if (startDate) match.date = { ...match.date, $gte: startDate };
    if (endDate)   match.date = { ...match.date, $lte: endDate };

    const total   = await AttendanceRecord.countDocuments(match);
    const records = await AttendanceRecord.aggregate(
      recordListPipeline(match, { date: -1, created_at: -1 }, offset, limit)
    );

    const todayIST = istDateStr();
    const formatted = records.map(r => {
      const rec = formatRecord(r);
      if (r.status === 'Draft' && r.date < todayIST && r.checkin_time && !r.checkout_time) {
        rec.isMissedCheckout = true;
        rec.status           = 'Pending';
        rec.checkoutRemarks  = rec.checkoutRemarks || 'Employee did not check out. Requires manager approval.';
      }
      return rec;
    });

    res.json({ success: true, data: formatted, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/today
// ─────────────────────────────────────────────────────────────────────────────
router.get('/today', authenticate, async (req, res) => {
  try {
    const today = istDateStr();
    const rows = await AttendanceRecord.aggregate([
      { $match: { emp_id: req.user.id, date: today } },
      { $lookup: { from: 'users', localField: 'emp_id', foreignField: '_id', as: 'emp' } },
      { $addFields: { emp_name: { $arrayElemAt: ['$emp.name', 0] }, emp_code: { $arrayElemAt: ['$emp.emp_id', 0] } } },
      { $project: { emp: 0 } },
    ]);
    res.json({
      success: true,
      data: rows.length ? formatRecord(rows[0]) : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/today-checkin-status
// Returns today's check-in status map { [emp_id]: { checkedIn, checkedOut,
// checkinTime, checkoutTime, status } } for admin/hr/super_admin/manager.
// Used by the admin Users page to show live check-in badges.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/today-checkin-status', authenticate, authorize('admin', 'hr', 'super_admin', 'manager'), async (req, res) => {
  try {
    const today = istDateStr();
    let empFilter = {};
    if (req.user.role === 'manager') {
      const team = await User.find({ manager_id: req.user.id }).select('_id').lean();
      empFilter = { emp_id: { $in: team.map(m => String(m._id)) } };
    }

    // Fetch check-in records and approved leaves in parallel
    const [records, leaves] = await Promise.all([
      AttendanceRecord.find(
        { date: today, checkin_time: { $ne: null }, ...empFilter },
        'emp_id checkin_time checkout_time status'
      ).lean(),
      AttendanceRecord.find(
        {
          duty_type: 'Leave', leave_status: 'Approved',
          $or: [
            { date: today, end_date: null },
            { date: { $lte: today }, end_date: { $gte: today } },
          ],
          ...empFilter,
        },
        'emp_id leave_type'
      ).lean(),
    ]);

    const statusMap = {};
    records.forEach(r => {
      statusMap[String(r.emp_id)] = {
        checkedIn:   true,
        checkedOut:  !!r.checkout_time,
        checkinTime:  r.checkin_time  || null,
        checkoutTime: r.checkout_time || null,
        status:       r.status,
      };
    });
    // Add leave entries (don't overwrite if somehow also checked in)
    leaves.forEach(r => {
      const uid = String(r.emp_id);
      if (!statusMap[uid]) {
        statusMap[uid] = { onLeave: true, leaveType: r.leave_type || 'Leave' };
      }
    });

    res.json({ success: true, data: statusMap });
  } catch (err) {
    console.error('[TodayCheckinStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/export — Excel export for manager/admin queue
// ─────────────────────────────────────────────────────────────────────────────
router.get('/export', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { status, startDate, endDate, empId, format = 'excel' } = req.query;
    const match = {};

    if (req.user.role === 'manager') {
      if (empId) {
        const emp = await User.findOne({ _id: empId, manager_id: req.user.id }).lean();
        if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });
        match.emp_id = empId;
      } else {
        const team = await User.find({ manager_id: req.user.id }).select('_id').lean();
        match.emp_id = { $in: team.map(m => m._id) };
      }
    } else if (empId) {
      match.emp_id = empId;
    }

    if (status) {
      if (status === 'Pending') {
        const todayIST = istDateStr();
        match.$or = [
          { status: 'Pending' },
          { status: 'Draft', date: { $lt: todayIST }, checkin_time: { $ne: null }, checkout_time: null },
        ];
      } else {
        match.status = status;
      }
    }
    if (startDate) match.date = { ...match.date, $gte: startDate };
    if (endDate)   match.date = { ...match.date, $lte: endDate };

    const records = await AttendanceRecord.aggregate([
      { $match: match },
      { $lookup: { from: 'users', localField: 'emp_id', foreignField: '_id', as: 'emp' } },
      { $addFields: {
        emp_name:          { $arrayElemAt: ['$emp.name',              0] },
        emp_code:          { $arrayElemAt: ['$emp.emp_id',            0] },
        designation:       { $arrayElemAt: ['$emp.designation',       0] },
        assigned_district: { $arrayElemAt: ['$emp.assigned_district', 0] },
        assigned_block:    { $arrayElemAt: ['$emp.assigned_block',    0] },
      }},
      { $project: { emp: 0 } },
      { $sort: { emp_code: 1, date: 1 } },
      { $limit: 5000 },
    ]);

    // ── Group records by employee (emp_code ASC already from sort) ──────────
    const empGroups = [];
    const empIndex  = new Map();
    for (const r of records) {
      const key = r.emp_code || String(r.emp_id);
      if (!empIndex.has(key)) {
        const g = { info: r, rows: [] };
        empGroups.push(g);
        empIndex.set(key, g);
      }
      empIndex.get(key).rows.push(r);
    }

    // ── Total-time helpers ───────────────────────────────────────────────────
    const calcTotalMins = (checkin, checkout) => {
      if (!checkin || !checkout) return 0;
      try {
        const [ch, cm] = checkin.split(':').map(Number);
        const [oh, om] = checkout.split(':').map(Number);
        return Math.max(0, (oh * 60 + om) - (ch * 60 + cm));
      } catch { return 0; }
    };

    const calcTotalTime = (checkin, checkout) => {
      const mins = calcTotalMins(checkin, checkout);
      if (!mins) return '';
      const h = Math.floor(mins / 60), m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    // Color thresholds matching checkout rules (attendance.js)
    // >= 9h → green (ideal)  |  >= 6h → teal (full day)
    // >= 4h → amber (half day)  |  < 4h → red (emergency)
    const timeColor = (mins) => {
      if (!mins) return null;
      const h = mins / 60;
      if (h >= 9) return { pdf: '#059669', xl: 'FF059669' }; // green
      if (h >= 6) return { pdf: '#0D9488', xl: 'FF0D9488' }; // teal  — full day
      if (h >= 4) return { pdf: '#D97706', xl: 'FFD97706' }; // amber — half day
      return            { pdf: '#DC2626', xl: 'FFDC2626' }; // red   — emergency
    };

    // ── Per-employee attendance summary ──────────────────────────────────────
    const calcSummary = (rows) => {
      const s = {
        total: rows.length,
        working: 0,   // checked in, not a leave/holiday
        holidays: 0,
        leaves: 0,
        missed: 0,    // missed checkout (blocked)
        absent: 0,    // no checkin, no leave, no holiday
        approved: 0,
        pending: 0,
        rejected: 0,
        leaveTypes: {},
      };
      rows.forEach(r => {
        const isMissed  = r.status === 'Draft' && r.checkin_time && !r.checkout_time;
        const isHoliday = (r.duty_type || '').toLowerCase().includes('holiday');
        const isLeave   = r.duty_type === 'Leave' || !!r.leave_type;

        if (isMissed)        s.missed++;
        if (isHoliday)       s.holidays++;
        else if (isLeave)  { s.leaves++; const lt = (r.leave_type || 'Leave').trim(); s.leaveTypes[lt] = (s.leaveTypes[lt] || 0) + 1; }
        else if (r.checkin_time) s.working++;
        else                 s.absent++;

        if (r.status === 'Approved')       s.approved++;
        else if (r.status === 'Pending')   s.pending++;
        else if (r.status === 'Rejected')  s.rejected++;
      });
      return s;
    };

    const fmtLeaveBreakdown = (leaveTypes) => {
      const parts = Object.entries(leaveTypes).map(([k, v]) => `${k}:${v}`).join(', ');
      return parts ? ` (${parts})` : '';
    };

    const summaryLine = (s) =>
      `Total: ${s.total} days  |  Working: ${s.working}  |  Holidays: ${s.holidays}  |  Leaves: ${s.leaves}${fmtLeaveBreakdown(s.leaveTypes)}  |  Missed Checkout: ${s.missed}  |  Absent: ${s.absent}  ||  Approved: ${s.approved}  Pending: ${s.pending}  Rejected: ${s.rejected}`;

    const tag = [status || 'All', startDate, endDate].filter(Boolean).join('_');

    // ── PDF export ──────────────────────────────────────────────────────────
    if (format === 'pdf') {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ margin: 0, size: 'A4', layout: 'landscape' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Queue_${tag}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const PAGE_W = 841.89, PAGE_H = 595.28, MARGIN = 24;
      const NAVY   = '#1E3A5F', NAVY_H = '#152C47', NAVY_EMP = '#2D5A8E';
      const SUM_BG = '#0F4C2A', SUM_FG = '#DCFCE7';
      const SUB_BG = '#E8EFF7', ALT_BG = '#F4F7FB';
      const LEAVE_APR = '#DCFCE7'; // green  — approved leave
      const LEAVE_PND = '#FEF9C3'; // yellow — applied/pending
      const LEAVE_REJ = '#FEE2E2'; // red    — rejected
      const WHITE  = '#FFFFFF', BORDER = '#CBD5E1', TEXT_D = '#0F172A';

      const cols  = [80, 68, 68, 60, 90, 90];
      const TOTAL_COL = cols.length;
      const heads = ['Date', 'Check-In', 'Check-Out', 'Total Time', 'Duty Type', 'Leave Type'];
      const tableW = cols.reduce((s, c) => s + c, 0);
      const ROW_H = 16, SUB_H = 18, EMP_H = 22, SUM_H = 32, BANNER_H = 50;

      const generatedDate = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

      doc.rect(0, 0, PAGE_W, BANNER_H).fill(NAVY_H);
      doc.fillColor(WHITE).fontSize(13).font('Helvetica-Bold')
        .text('BRP — Attendance Queue Report', MARGIN, 10, { width: PAGE_W - MARGIN * 2, align: 'center' });
      doc.fontSize(7.5).font('Helvetica').fillColor('#BAD3ED')
        .text(
          `Filter: ${status || 'All'}  ·  Period: ${startDate || 'All'} → ${endDate || 'All'}  ·  ${empGroups.length} employee(s)  ·  Generated: ${generatedDate}`,
          MARGIN, 32, { width: PAGE_W - MARGIN * 2, align: 'center' }
        );

      let y = BANNER_H + 8;

      const ensureSpace = (needed) => {
        if (y + needed > PAGE_H - 20) {
          doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
          y = 16;
        }
      };

      const drawSubHeader = (yPos) => {
        doc.rect(MARGIN, yPos, tableW, SUB_H).fill(SUB_BG);
        let x = MARGIN;
        doc.fillColor(NAVY).fontSize(7).font('Helvetica-Bold');
        heads.forEach((h, i) => {
          doc.text(h, x + 4, yPos + 5, { width: cols[i] - 6, lineBreak: false });
          x += cols[i];
        });
      };

      const drawRowBorders = (yPos, rh) => {
        doc.moveTo(MARGIN, yPos + rh).lineTo(MARGIN + tableW, yPos + rh)
          .strokeColor(BORDER).lineWidth(0.25).stroke();
        let vx = MARGIN;
        for (let i = 0; i <= TOTAL_COL; i++) {
          doc.moveTo(vx, yPos).lineTo(vx, yPos + rh).strokeColor(BORDER).lineWidth(0.2).stroke();
          if (i < TOTAL_COL) vx += cols[i];
        }
      };

      empGroups.forEach(({ info, rows }, gi) => {
        const sum = calcSummary(rows);
        ensureSpace(EMP_H + SUB_H + ROW_H + SUM_H);
        if (gi > 0) y += 8;

        // Employee header banner
        const empLabel = [info.emp_code || '—', info.emp_name || '—', info.designation || '', info.assigned_district || '', info.assigned_block || ''].filter(Boolean).join('  ·  ');
        doc.rect(MARGIN, y, tableW, EMP_H).fill(NAVY_EMP);
        doc.fillColor(WHITE).fontSize(8.5).font('Helvetica-Bold')
          .text(empLabel, MARGIN + 8, y + 7, { width: tableW - 12, lineBreak: false, ellipsis: true });
        doc.fillColor('#BAD3ED').fontSize(7).font('Helvetica')
          .text(`${rows.length} record${rows.length !== 1 ? 's' : ''}`, MARGIN + tableW - 64, y + 8, { width: 56, align: 'right', lineBreak: false });
        y += EMP_H;

        // Column sub-header
        drawSubHeader(y);
        y += SUB_H;

        // Data rows
        rows.forEach((r, ri) => {
          ensureSpace(ROW_H + 2);
          const isMissed = r.status === 'Draft' && r.checkin_time && !r.checkout_time;
          const totalTime = calcTotalTime(r.checkin_time, r.checkout_time);
          const cells = [
            r.date || '',
            r.checkin_time || '—',
            r.checkout_time || (isMissed ? 'Missed' : '—'),
            totalTime,
            r.duty_type || '',
            r.leave_type || '',
          ];
          const isLeave = r.duty_type === 'Leave' || !!r.leave_type;
          const lvStatus = r.leave_status || r.status || '';
          const rowBg = isLeave
            ? (lvStatus === 'Approved' ? LEAVE_APR : lvStatus === 'Rejected' ? LEAVE_REJ : LEAVE_PND)
            : (ri % 2 === 1 ? ALT_BG : null);
          if (rowBg) doc.rect(MARGIN, y, tableW, ROW_H).fill(rowBg);
          let x = MARGIN;
          doc.fontSize(7).font('Helvetica');
          const ttPdfColor = timeColor(calcTotalMins(r.checkin_time, r.checkout_time))?.pdf;
          cells.forEach((cell, ci) => {
            const color = ci === 3 && ttPdfColor ? ttPdfColor
                        : ci === 5 && cell       ? '#7C3AED'   // leave type → purple
                        : TEXT_D;
            doc.fillColor(color).text(String(cell), x + 4, y + 4, { width: cols[ci] - 6, lineBreak: false, ellipsis: true });
            x += cols[ci];
          });
          drawRowBorders(y, ROW_H);
          y += ROW_H;
        });

        // Outer border around data
        doc.rect(MARGIN, y - (SUB_H + rows.length * ROW_H), tableW, SUB_H + rows.length * ROW_H).stroke(BORDER);

        // ── Per-employee summary band ──────────────────────────────────────
        ensureSpace(SUM_H);
        doc.rect(MARGIN, y, tableW, SUM_H).fill(SUM_BG);

        // Row 1: Working / Holidays / Leaves / Missed / Absent
        const leaveDetail = `${sum.leaves}${fmtLeaveBreakdown(sum.leaveTypes)}`;
        const line1 = `Working Days: ${sum.working}     Holidays: ${sum.holidays}     Leaves: ${leaveDetail}     Missed Checkout: ${sum.missed}     Absent: ${sum.absent}     Total Days: ${sum.total}`;
        doc.fillColor(SUM_FG).fontSize(7.5).font('Helvetica-Bold')
          .text(line1, MARGIN + 8, y + 5, { width: tableW - 14, lineBreak: false, ellipsis: true });

        // Row 2: Approval status breakdown
        const line2 = `Approved: ${sum.approved}     Pending: ${sum.pending}     Rejected: ${sum.rejected}`;
        doc.fillColor('#86EFAC').fontSize(7).font('Helvetica')
          .text(line2, MARGIN + 8, y + 18, { width: tableW - 14, lineBreak: false });

        y += SUM_H;
      });

      // ── Grand-total summary table at end of PDF ──────────────────────────
      ensureSpace(30 + empGroups.length * 16 + 30);
      y += 16;
      doc.rect(MARGIN, y, tableW, 22).fill(NAVY_H);
      doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold')
        .text('Summary — All Employees', MARGIN + 8, y + 6, { width: tableW - 14, lineBreak: false });
      y += 22;

      // Grand-total sub-header
      const gtCols  = [60, 110, 55, 55, 55, 55, 55, 55, 55, 55];
      const gtHeads = ['Emp ID', 'Name', 'Total', 'Working', 'Holidays', 'Leaves', 'Missed', 'Absent', 'Approved', 'Pend/Rej'];
      const gtW = gtCols.reduce((s, c) => s + c, 0);

      const drawGtHdr = (yPos) => {
        doc.rect(MARGIN, yPos, gtW, 18).fill(SUB_BG);
        let x = MARGIN;
        doc.fillColor(NAVY).fontSize(7).font('Helvetica-Bold');
        gtHeads.forEach((h, i) => {
          doc.text(h, x + 3, yPos + 5, { width: gtCols[i] - 4, lineBreak: false });
          x += gtCols[i];
        });
      };
      drawGtHdr(y);
      y += 18;

      empGroups.forEach(({ info, rows }, gi) => {
        ensureSpace(16);
        const s = calcSummary(rows);
        const leaveStr = `${s.leaves}${fmtLeaveBreakdown(s.leaveTypes)}`;
        const cells = [
          info.emp_code || '', info.emp_name || '', String(s.total),
          String(s.working), String(s.holidays), leaveStr,
          String(s.missed), String(s.absent), String(s.approved),
          `${s.pending}/${s.rejected}`,
        ];
        if (gi % 2 === 1) doc.rect(MARGIN, y, gtW, 16).fill(ALT_BG);
        let x = MARGIN;
        doc.fontSize(7).font('Helvetica').fillColor(TEXT_D);
        cells.forEach((cell, ci) => {
          doc.text(String(cell), x + 3, y + 4, { width: gtCols[ci] - 4, lineBreak: false, ellipsis: true });
          x += gtCols[ci];
        });
        doc.moveTo(MARGIN, y + 16).lineTo(MARGIN + gtW, y + 16).strokeColor(BORDER).lineWidth(0.2).stroke();
        y += 16;
      });

      // Grand totals row
      const grand = empGroups.reduce((acc, { rows }) => {
        const s = calcSummary(rows);
        acc.total += s.total; acc.working += s.working; acc.holidays += s.holidays;
        acc.leaves += s.leaves; acc.missed += s.missed; acc.absent += s.absent;
        acc.approved += s.approved; acc.pending += s.pending; acc.rejected += s.rejected;
        return acc;
      }, { total:0, working:0, holidays:0, leaves:0, missed:0, absent:0, approved:0, pending:0, rejected:0 });

      doc.rect(MARGIN, y, gtW, 18).fill('#1E3A5F');
      const grandCells = ['TOTAL', `${empGroups.length} employees`, String(grand.total), String(grand.working), String(grand.holidays), String(grand.leaves), String(grand.missed), String(grand.absent), String(grand.approved), `${grand.pending}/${grand.rejected}`];
      let gx = MARGIN;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(WHITE);
      grandCells.forEach((cell, ci) => {
        doc.text(String(cell), gx + 3, y + 5, { width: gtCols[ci] - 4, lineBreak: false, ellipsis: true });
        gx += gtCols[ci];
      });

      doc.end();
      return;
    }

    // ── Excel export (grouped by employee) ─────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'RAMP AMS';
    const ws  = wb.addWorksheet('Attendance Detail');
    const wss = wb.addWorksheet('Summary');       // second sheet: cross-employee summary

    // ── Attendance Detail sheet ─────────────────────────────────────────────
    ws.getColumn(1).width = 14; // Date
    ws.getColumn(2).width = 13; // Check-In
    ws.getColumn(3).width = 13; // Check-Out
    ws.getColumn(4).width = 13; // Total Time
    ws.getColumn(5).width = 16; // Duty Type
    ws.getColumn(6).width = 18; // Leave Type

    const NCOLS = 6;
    const FILL_EMP   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5A8E' } };
    const FILL_SUBHD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD0E4F7' } };
    const FILL_SUM      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C2A' } };
    const FILL_ALT      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FB' } };
    const FILL_WHT      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const FILL_LV_APR   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } }; // green  — approved
    const FILL_LV_PND   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF9C3' } }; // yellow — applied/pending
    const FILL_LV_REJ   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }; // red    — rejected
    const THIN_BORDER = { style: 'thin', color: { argb: 'FFCBD5E1' } };
    const CELL_BORDER = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
    const FONT_WHITE  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    const FONT_SUBHD  = { bold: true, color: { argb: 'FF1E3A5F' }, size: 9,  name: 'Calibri' };
    const FONT_DATA   = { size: 9, name: 'Calibri' };
    const FONT_SUM    = { bold: true, color: { argb: 'FFDCFCE7' }, size: 9, name: 'Calibri' };

    const styleRow = (row, fill, font, height = 15, hAlign = 'center') => {
      row.height = height;
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = fill; cell.font = font; cell.border = CELL_BORDER;
        cell.alignment = { vertical: 'middle', horizontal: hAlign, wrapText: false };
      });
    };

    const mergedCell = (row, fill, font, text, hAlign = 'left') => {
      ws.mergeCells(row.number, 1, row.number, NCOLS);
      const c = row.getCell(1);
      c.value = text; c.fill = fill; c.font = font; c.border = CELL_BORDER;
      c.alignment = { vertical: 'middle', horizontal: hAlign, wrapText: false };
    };

    empGroups.forEach(({ info, rows }, gi) => {
      const sum = calcSummary(rows);

      // Employee header (merged)
      const empLabel = [info.emp_code || '', info.emp_name || '', info.designation || '', info.assigned_district || '', info.assigned_block || ''].filter(Boolean).join('   |   ');
      const empRow = ws.addRow(['', '', '', '', '']);
      empRow.height = 20;
      mergedCell(empRow, FILL_EMP, FONT_WHITE, empLabel);

      // Column sub-header
      const subRow = ws.addRow(['Date', 'Check-In', 'Check-Out', 'Total Time', 'Duty Type', 'Leave Type']);
      styleRow(subRow, FILL_SUBHD, FONT_SUBHD, 15);

      // Data rows
      rows.forEach((r, ri) => {
        const isMissed = r.status === 'Draft' && r.checkin_time && !r.checkout_time;
        const dataRow = ws.addRow([
          r.date || '',
          r.checkin_time || '',
          r.checkout_time || (isMissed ? 'Missed' : ''),
          calcTotalTime(r.checkin_time, r.checkout_time),
          r.duty_type || '',
          r.leave_type || '',
        ]);
        const isLeaveRow = r.duty_type === 'Leave' || !!r.leave_type;
        const lvSt = r.leave_status || r.status || '';
        const rowFill = isLeaveRow
          ? (lvSt === 'Approved' ? FILL_LV_APR : lvSt === 'Rejected' ? FILL_LV_REJ : FILL_LV_PND)
          : (ri % 2 === 0 ? FILL_WHT : FILL_ALT);
        styleRow(dataRow, rowFill, FONT_DATA, 15);
        // Override Total Time (col 4) font colour based on duration thresholds
        const ttXlColor = timeColor(calcTotalMins(r.checkin_time, r.checkout_time))?.xl;
        if (ttXlColor) {
          const ttCell = dataRow.getCell(4);
          ttCell.font = { ...FONT_DATA, color: { argb: ttXlColor }, bold: true };
        }
      });

      // ── Per-employee summary row (2 lines in 2 rows, merged) ──
      const leaveDetail = `${sum.leaves}${fmtLeaveBreakdown(sum.leaveTypes)}`;

      const sumRow1 = ws.addRow(['', '', '', '', '']);
      sumRow1.height = 16;
      mergedCell(sumRow1, FILL_SUM, FONT_SUM,
        `Working Days: ${sum.working}   |   Holidays: ${sum.holidays}   |   Leaves: ${leaveDetail}   |   Missed Checkout: ${sum.missed}   |   Absent: ${sum.absent}   |   Total: ${sum.total} days`);

      const sumRow2 = ws.addRow(['', '', '', '', '']);
      sumRow2.height = 15;
      mergedCell(sumRow2, FILL_SUM, { ...FONT_SUM, bold: false, color: { argb: 'FF86EFAC' }, size: 8 },
        `Approved: ${sum.approved}   |   Pending: ${sum.pending}   |   Rejected: ${sum.rejected}`);

      if (gi < empGroups.length - 1) ws.addRow([]);
    });

    ws.views = [{ state: 'normal' }];

    // ── Summary sheet ───────────────────────────────────────────────────────
    const SCOLS = 10;
    [18, 22, 10, 12, 12, 16, 12, 10, 12, 14].forEach((w, i) => { wss.getColumn(i + 1).width = w; });

    const FILL_SNAV  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const FILL_SHDR  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD0E4F7' } };
    const FILL_SALT  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FB' } };
    const FILL_SGRD  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C2A' } };
    const CB = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };
    const sStyle = (cell, fill, font, hAlign = 'center') => {
      cell.fill = fill; cell.font = font; cell.border = CB;
      cell.alignment = { vertical: 'middle', horizontal: hAlign, wrapText: false };
    };

    // Title
    const titleRow = wss.addRow(['Attendance Summary Report', ...Array(SCOLS - 1).fill('')]);
    titleRow.height = 24;
    wss.mergeCells(titleRow.number, 1, titleRow.number, SCOLS);
    sStyle(titleRow.getCell(1), FILL_SNAV, { bold: true, color: { argb: 'FFFFFFFF' }, size: 13, name: 'Calibri' }, 'center');

    // Period row
    const periodRow = wss.addRow([`Filter: ${status || 'All'}   Period: ${startDate || 'All'} → ${endDate || 'All'}   Generated: ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`, ...Array(SCOLS - 1).fill('')]);
    periodRow.height = 16;
    wss.mergeCells(periodRow.number, 1, periodRow.number, SCOLS);
    sStyle(periodRow.getCell(1), { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EFF7' } }, { size: 9, color: { argb: 'FF1E3A5F' }, name: 'Calibri' }, 'center');

    wss.addRow([]);

    // Column headers
    const sHdrRow = wss.addRow(['Emp ID', 'Name', 'Total Days', 'Working', 'Holidays', 'Leaves', 'Missed', 'Absent', 'Approved', 'Pend / Rej']);
    sHdrRow.height = 16;
    sHdrRow.eachCell((cell, col) => sStyle(cell, FILL_SHDR, { bold: true, color: { argb: 'FF1E3A5F' }, size: 9, name: 'Calibri' }));
    wss.views = [{ state: 'frozen', ySplit: sHdrRow.number }];

    // Per-employee rows
    const grandTotals = { total:0, working:0, holidays:0, leaves:0, missed:0, absent:0, approved:0, pending:0, rejected:0 };
    empGroups.forEach(({ info, rows }, gi) => {
      const s = calcSummary(rows);
      Object.keys(grandTotals).forEach(k => { grandTotals[k] += s[k]; });
      const leaveStr = `${s.leaves}${fmtLeaveBreakdown(s.leaveTypes)}`;
      const row = wss.addRow([
        info.emp_code || '', info.emp_name || '',
        s.total, s.working, s.holidays, leaveStr,
        s.missed, s.absent, s.approved, `${s.pending} / ${s.rejected}`,
      ]);
      row.height = 15;
      row.eachCell((cell, col) => {
        const hAlign = col <= 2 ? 'left' : 'center';
        sStyle(cell, gi % 2 === 0 ? FILL_WHT : FILL_SALT, FONT_DATA, hAlign);
      });
    });

    // Grand-total row
    const gtRow = wss.addRow([
      'GRAND TOTAL', `${empGroups.length} employees`,
      grandTotals.total, grandTotals.working, grandTotals.holidays,
      grandTotals.leaves, grandTotals.missed, grandTotals.absent,
      grandTotals.approved, `${grandTotals.pending} / ${grandTotals.rejected}`,
    ]);
    gtRow.height = 18;
    gtRow.eachCell(cell => sStyle(cell, FILL_SGRD, FONT_SUM, 'center'));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Queue_${tag}.xlsx"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    await wb.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('[attendance/export]', err);
    res.status(500).json({ success: false, message: 'Export failed: ' + err.message });
  }
});

// GET /api/attendance/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const rows = await AttendanceRecord.aggregate([
      { $match: { _id: req.params.id } },
      { $lookup: { from: 'users', localField: 'emp_id',      foreignField: '_id', as: 'emp'             } },
      { $lookup: { from: 'users', localField: 'manager_id',  foreignField: '_id', as: 'manager'         } },
      { $lookup: { from: 'users', localField: 'actioned_by', foreignField: '_id', as: 'actioned_by_user'} },
      { $addFields: {
        emp_name:          { $arrayElemAt: ['$emp.name',               0] },
        emp_code:          { $arrayElemAt: ['$emp.emp_id',             0] },
        department:        { $arrayElemAt: ['$emp.department',         0] },
        emp_phone:         { $arrayElemAt: ['$emp.phone',              0] },
        emp_face_photo:    { $arrayElemAt: ['$emp.facePhotoUrl',       0] },
        emp_profile_photo: { $arrayElemAt: ['$emp.profile_photo_path', 0] },
        manager_name:      { $arrayElemAt: ['$manager.name',           0] },
        manager_email:     { $arrayElemAt: ['$manager.email',          0] },
        actioned_by_name:  { $arrayElemAt: ['$actioned_by_user.name',  0] },
      }},
      { $project: { emp: 0, manager: 0, actioned_by_user: 0 } },
    ]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    const record = rows[0];
    if (req.user.role === 'employee' && record.emp_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied' });
    if (req.user.role === 'manager'  && record.manager_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, data: formatRecord(record) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/checkin
// ─────────────────────────────────────────────────────────────────────────────
router.post('/checkin', authenticate, authorize('employee'), upload.single('selfie'), [
  body('dutyType').isIn(['Office Duty', 'On Duty', 'On Duty Away']),
  body('latitude').isFloat(),
  body('longitude').isFloat(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const today = istDateStr();

    // Block if the most recent past attendance (within last 7 days) has no activity
    const sevenDaysAgo = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const prevRecord = await AttendanceRecord.findOne({
      emp_id:       req.user.id,
      date:         { $gte: sevenDaysAgoStr, $lt: today },
      checkin_time: { $ne: null },
      status:       { $in: ['Approved', 'Pending', 'Draft'] },
    }).sort({ date: -1 }).lean();


    const existing = await AttendanceRecord.findOne({ emp_id: req.user.id, date: today }).lean();
    let existingRejectedLeaveId = null;
    if (existing) {
      const isRejectedLeave =
        (existing.duty_type === 'Leave' || (existing.leave_type && existing.leave_type.trim())) &&
        (existing.leave_status === 'Rejected' || existing.status === 'Rejected') &&
        !existing.checkin_time;
      if (!isRejectedLeave) {
        return res.status(409).json({ success: false, message: 'Attendance already recorded for today' });
      }
      existingRejectedLeaveId = existing._id;
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Selfie is required for check-in.' });
    }

    const currentUserInfo = await User.findById(req.user.id).select('name').lean();

    const { dutyType, sector, description, latitude, longitude, locationAddress, capturedAt, capturedDate } = req.body;

    if (dutyType === 'On Duty' && !sector)
      return res.status(400).json({ success: false, message: 'Sector is required for On Duty' });

    const currentUser = await User.findById(req.user.id).select('manager_id name').lean();
    const managerId   = currentUser?.manager_id || null;

    const timeRe = /^\d{2}:\d{2}$/;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const checkinTime = (capturedAt && timeRe.test(capturedAt))     ? capturedAt   : istTimeStr();
    const checkinDate = (capturedDate && dateRe.test(capturedDate)) ? capturedDate : today;

    // Upload selfie immediately
    const selfiePath = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype);

    let id = uuidv4();
    const checkinFields = {
      emp_id: req.user.id, date: checkinDate, duty_type: dutyType, sector: sector || null,
      description: description || '', status: 'Draft', selfie_path: selfiePath,
      latitude: parseFloat(latitude), longitude: parseFloat(longitude),
      location_address: locationAddress || '', checkin_time: checkinTime,
      checkin_lat: parseFloat(latitude), checkin_lng: parseFloat(longitude),
      manager_id: managerId,
      leave_type: null, leave_reason: null, leave_status: null, end_date: null,
      checkout_time: null, worked_hours: null, submitted_at: null,
      actioned_by: null, actioned_at: null, manager_remark: null,
      hr_override: false, hr_remark: null, override_remark: null,
      overridden_by: null, hr_actioned_at: null,
      is_missed_checkout: false, checkout_remarks: null,
      face_verification_status: 'verified',
      face_confidence:          100,
    };

    if (existingRejectedLeaveId) {
      await AttendanceRecord.findByIdAndUpdate(existingRejectedLeaveId, { $set: checkinFields });
      id = existingRejectedLeaveId;
    } else {
      await AttendanceRecord.create({ _id: id, ...checkinFields });
    }

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHECKIN', entity_type: 'attendance', entity_id: id });
    const record = await AttendanceRecord.findById(id).lean();

    res.status(201).json({
      success:             true,
      message:             'Check-in recorded!',
      verificationPending: false,
      data:                formatRecord(record),
    });

  } catch (err) {
    // Only reached if an error occurs BEFORE res.status(201) was sent
    if (!res.headersSent) {
      console.error('[CheckIn] Error:', err.message || err);
      res.status(500).json({ success: false, message: 'Server error' });
    } else {
      console.error('[CheckIn] Post-response error (non-fatal):', err.message || err);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id/cancel-checkin
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id/cancel-checkin', authenticate, authorize('employee', 'super_admin'), async (req, res) => {
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id }).lean();
    if (!record)             return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.status !== 'Draft') return res.status(400).json({ success: false, message: 'Only Draft records can be deleted' });
    if (record.checkout_time)      return res.status(400).json({ success: false, message: 'Already checked out — cannot delete' });

    const deleted = await AttendanceRecord.deleteOne({ _id: req.params.id });
    console.log('[CancelCheckin] deleteOne result:', deleted);

    try {
      await AuditLog.create({
        _id: uuidv4(), user_id: req.user.id, action: 'CANCEL_CHECKIN',
        entity_type: 'attendance', entity_id: req.params.id,
        old_value: record.status, new_value: 'DELETED',
      });
    } catch (auditErr) {
      console.error('[CancelCheckin] AuditLog failed (non-fatal):', auditErr.message);
    }

    res.json({ success: true, message: 'Check-in deleted. Employee can check in again.' });
  } catch (err) {
    console.error('[CancelCheckin] Error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/retake-face
// Employee retakes selfie after a failed face verification.
// Uses a lower threshold (40%) — gives benefit of doubt on second attempt.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/retake-face', authenticate, authorize('employee'), upload.single('selfie'), async (req, res) => {
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (!req.file)
      return res.status(400).json({ success: false, message: 'Selfie is required.' });

    const newSelfiePath = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype);

    await AttendanceRecord.findByIdAndUpdate(req.params.id, {
      $set: { face_verification_status: 'verified', face_confidence: 100, selfie_path: newSelfiePath },
    });

    const updated = await AttendanceRecord.findById(req.params.id).lean();

    res.json({
      success:       true,
      message:       'Selfie updated.',
      retakePending: false,
      data:          formatRecord(updated),
    });

  } catch (err) {
    if (!res.headersSent) {
      console.error('[RetakeFace] Error:', err.message || err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/checkout
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/checkout', authenticate, authorize('employee'), upload.single('checkoutSelfie'), async (req, res) => {
  try {
    const isEmergency = req.body.emergency === 'true' || req.body.emergency === true;
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record)               return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.checkout_time)  return res.status(409).json({ success: false, message: 'Already checked out' });
    // Allow checkout from Draft (normal) OR Pending-without-checkout (face verify escalated to manager but employee still needs to checkout)
    if (!['Draft', 'Pending'].includes(record.status)) return res.status(400).json({ success: false, message: 'Cannot checkout — record already processed' });

    const now             = new Date();
    const checkinDateTime = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
    const capturedAtBody  = req.body?.capturedAt;
    const timeRe          = /^\d{2}:\d{2}$/;
    const effectiveNow    = (capturedAtBody && timeRe.test(capturedAtBody))
      ? (() => { const d = new Date(`${record.date}T${capturedAtBody}:00+05:30`); return d <= now ? d : now; })()
      : now;

    const hoursElapsed = (effectiveNow - checkinDateTime) / 3600000;

    // Enforce 4-hour minimum unless emergency
    if (!isEmergency && hoursElapsed < 4) {
      const remaining = 4 - hoursElapsed;
      const h = Math.floor(remaining);
      const m = Math.floor((remaining - h) * 60);
      return res.status(400).json({
        success: false,
        message: `Check-out locked for ${h}h ${m}m more (minimum 4 hours after check-in).`,
        hoursRemaining: remaining,
      });
    }

    // ── Determine leave type and auto-approval ────────────────────────────
    // >= 7 hours → auto-approved, no manager review
    // >= 6 hours → full day, needs manager review
    // >= 4 hours → half day leave attached, manager review
    // <  4 hours → emergency leave, manager review
    const AUTO_APPROVE_HOURS = 6;
    const isAutoApproved = hoursElapsed >= AUTO_APPROVE_HOURS;

    let leaveType = null;
    if (hoursElapsed >= 6) {
      leaveType = null;               // Full day — no leave (whether auto-approved or pending)
    } else if (hoursElapsed >= 4) {
      leaveType = 'Half Day';
    } else {
      leaveType = 'Emergency Leave';
    }

    const { latitude, longitude, locationAddress, capturedAt } = req.body;

    let checkoutTime = istTimeStr();
    let workedHours  = Math.round(hoursElapsed * 100) / 100;
    if (capturedAt && timeRe.test(capturedAt)) {
      const capturedDT = new Date(`${record.date}T${capturedAt}:00+05:30`);
      if (capturedDT <= now) {
        checkoutTime = capturedAt;
        workedHours  = Math.round(((capturedDT - checkinDateTime) / 3600000) * 100) / 100;
      }
    }

    const checkoutFaceConfidence = 0;

    const checkoutSelfiePath = req.file
      ? await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype)
      : null;

    const updateFields = {
      checkout_time:             checkoutTime,
      checkout_lat:              parseFloat(latitude)  || record.latitude,
      checkout_lng:              parseFloat(longitude) || record.longitude,
      checkout_location_address: locationAddress || record.location_address,
      checkout_selfie_path:      checkoutSelfiePath,
      submitted_at:              now,
      worked_hours:              workedHours,
      leave_type:                leaveType,
      leave_status:              leaveType ? (isAutoApproved ? 'Approved' : 'Pending') : null,
    };

     if (isAutoApproved) {
          // Direct approval — no manager action needed
          updateFields.status       = 'Approved';
          updateFields.actioned_by  = null; // system-approved
          updateFields.actioned_at  = now;
          updateFields.manager_remark = `Auto-approved: worked ${workedHours.toFixed(1)} hours`;
    } else {
      updateFields.status = 'Pending';
      updateFields.manager_remark = `Worked ${workedHours.toFixed(1)} hours`;
        }
    
        await AttendanceRecord.findByIdAndUpdate(record._id, { $set: updateFields });
    
        // Notify manager only if NOT auto-approved
        if (!isAutoApproved && record.manager_id) {
          const emp = await User.findById(req.user.id).select('name').lean();
          const hoursLabel = hoursElapsed >= 6
            ? `Full day (${workedHours.toFixed(1)} hrs)`
            : hoursElapsed >= 4
            ? `Half Day (${workedHours.toFixed(1)} hrs)`
            : `Emergency Leave (${workedHours.toFixed(1)} hrs)`;
          await notify(
            record.manager_id,
            'New Attendance Pending',
            `${emp.name}'s attendance for ${record.date} is pending approval — ${hoursLabel}`,
            'warning', record._id, '/manager/queue'
          );
        }
    
        // Notify employee about auto-approval
        if (isAutoApproved) {
          await notify(
            record.emp_id,
            '✅ Attendance Auto-Approved',
            `Your attendance for ${record.date} was automatically approved (${workedHours.toFixed(1)} hrs worked).`,
            'success', record._id, '/employee/history'
          );
        }
    
        await AuditLog.create({
          _id: uuidv4(), user_id: req.user.id,
          action: isAutoApproved ? 'CHECKOUT_AUTO_APPROVED' : 'CHECKOUT',
          entity_type: 'attendance', entity_id: record._id,
        });
    
        const updated = await AttendanceRecord.findById(record._id).lean();
        res.json({
          success: true,
          message: isAutoApproved
            ? `Attendance auto-approved! You worked ${workedHours.toFixed(1)} hours.`
            : 'Checked out and submitted for approval',
          autoApproved:          isAutoApproved,
          faceConfidence:        checkoutFaceConfidence,
          data: formatRecord(updated),
        });
      } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
    });
    

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/apply-leave
// ─────────────────────────────────────────────────────────────────────────────
router.post('/apply-leave', authenticate, authorize('employee'), [
  body('date').isDate().withMessage('Valid start date required'),
  body('endDate').optional().isDate(),
  body('leaveType').isIn(['Casual Leave', 'Half Day', 'Emergency Leave']),
  body('reason').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { date, endDate, leaveType, reason } = req.body;
    const finalEndDate = endDate || date;
    if (finalEndDate < date) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });

    const todayISO = istDateStr();
    const minDate  = new Date(todayISO); minDate.setDate(minDate.getDate() - 30);
    const maxDate  = new Date(todayISO); maxDate.setDate(maxDate.getDate() + 60);
    const startD   = new Date(date), endD = new Date(finalEndDate);
    if (startD < minDate) return res.status(400).json({ success: false, message: 'Cannot apply leave more than 30 days in the past' });
    if (endD   > maxDate) return res.status(400).json({ success: false, message: 'Leave can only be planned up to 60 days in advance' });

    const currentUser = await User.findById(req.user.id).select('manager_id name').lean();
    const managerId   = currentUser?.manager_id;

    const existing = await AttendanceRecord.findOne({ emp_id: req.user.id, date }).lean();
    if (existing) return res.status(409).json({ success: false, message: `A record already exists for ${date}.` });

    const isMultiDay = finalEndDate !== date;
    const dayCount   = Math.round((endD - startD) / 86400000) + 1;
    const id = uuidv4();

    await AttendanceRecord.create({
      _id: id, emp_id: req.user.id, date, end_date: isMultiDay ? finalEndDate : null,
      duty_type: 'Leave', status: 'Pending', manager_id: managerId,
      leave_type: leaveType, leave_reason: reason, leave_status: 'Pending', submitted_at: new Date(),
    });
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'APPLY_LEAVE', entity_type: 'attendance', entity_id: id, new_value: leaveType });

    const dateRange = isMultiDay ? `${date} to ${finalEndDate}` : date;
    const leaveEmailBody = `<p><strong>${currentUser.name}</strong> has applied for <strong>${leaveType}</strong> ${isMultiDay ? `from <strong>${date}</strong> to <strong>${finalEndDate}</strong> (${dayCount} days)` : `on <strong>${date}</strong>`}.</p><p><strong>Reason:</strong> ${reason}</p>`;

    if (managerId) {
      await notify(managerId, `${leaveType} Request`,
        `${currentUser.name} applied for ${leaveType} (${dayCount} day${dayCount !== 1 ? 's' : ''}) — ${dateRange}: ${reason}`,
        'warning', id, '/manager/queue');
      const manager = await User.findById(managerId).select('email name').lean();
      if (manager?.email) {
        sendMail(manager.email, `[AMS] ${leaveType} Request – ${currentUser.name} (${dateRange})`,
          `<p>Hi ${manager.name},</p>${leaveEmailBody}`);
      }
    }

    // Also email all admins
    const admins = await User.find({ role: 'admin', is_active: { $ne: false } }).select('email name').lean();
    admins.forEach(admin => {
      if (admin.email) {
        sendMail(admin.email, `[AMS] ${leaveType} Request – ${currentUser.name} (${dateRange})`,
          `<p>Hi ${admin.name},</p>${leaveEmailBody}`);
      }
    });

    const isTodayInRange = todayISO >= date && todayISO <= finalEndDate;
    const record = await AttendanceRecord.findById(id).lean();
    res.status(201).json({
      success: true,
      message: `${leaveType} submitted for ${dayCount} day${dayCount !== 1 ? 's' : ''}`,
      count: dayCount,
      todayRecord: isTodayInRange ? formatRecord(record) : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/attendance/:id/cancel-leave  (employee only, Pending leaves only)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id/cancel-leave', authenticate, authorize('employee'), async (req, res) => {
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Leave record not found' });
    if (record.duty_type !== 'Leave') return res.status(400).json({ success: false, message: 'This record is not a leave request' });
    if (record.leave_status === 'Approved') return res.status(403).json({ success: false, message: 'Cannot cancel an approved leave' });
    if (record.leave_status === 'Rejected') return res.status(400).json({ success: false, message: 'This leave has already been rejected' });

    await AttendanceRecord.findByIdAndDelete(record._id);
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CANCEL_LEAVE', entity_type: 'attendance', entity_id: record._id, new_value: record.leave_type });

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name').lean();
      await notify(record.manager_id, 'Leave Cancelled', `${emp?.name} cancelled their ${record.leave_type} for ${record.date}`, 'info', null, '/manager/queue');
    }

    res.json({ success: true, message: 'Leave request cancelled successfully' });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/approve', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const today = istDateStr();
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    if (req.user.role === 'manager') {
      const emp = await User.findOne({ _id: record.emp_id, manager_id: req.user.id }).lean();
      if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });

      const isMissedDraft  = record.status === 'Draft' && record.checkin_time && !record.checkout_time && record.date < today;
      const isFaceReview   = record.face_verification_status === 'manager_review';
      if (!['Pending', 'Rejected'].includes(record.status) && !isMissedDraft && !isFaceReview)
        return res.status(400).json({ success: false, message: 'Cannot approve in current state' });

      if (isMissedDraft) {
        await AttendanceRecord.findByIdAndUpdate(record._id, {
          $set: { is_missed_checkout: true, status: 'Pending', checkout_remarks: 'Employee did not check out. Requires manager approval.' },
        });
      }
    }

    const isAdmin = req.user.role === 'admin';
    const update  = { status: 'Approved', manager_remark: remark || '', actioned_by: req.user.id, actioned_at: new Date() };
    if (isAdmin) update.admin_remark = remark || '';
    if (record.leave_type) update.leave_status = 'Approved';
    if (record.face_verification_status === 'manager_review') update.face_verification_status = 'manager_approved';

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: update });

    const notifTitle = record.is_missed_checkout ? 'Missed Check-Out Approved ✓' : record.leave_type ? 'Leave Approved ✓' : 'Attendance Approved ✓';
    const notifMsg   = record.is_missed_checkout
      ? `Your missed check-out on ${record.date} has been approved by your manager. You may check in again.`
      : record.leave_type ? `Your ${record.leave_type} for ${record.date} has been approved.` : `Your attendance for ${record.date} has been approved.`;

    await notify(record.emp_id, notifTitle, notifMsg, 'success', record._id, '/employee/history');

    if (record.leave_type) {
      const empUser = await User.findById(record.emp_id).select('email name').lean();
      if (empUser?.email) {
        sendMail(empUser.email, `[AMS] ${record.leave_type} Approved`,
          `<p>Hi ${empUser.name},</p><p>Your <strong>${record.leave_type}</strong> for <strong>${record.date}</strong> has been <strong style="color:#16a34a">approved</strong>.</p>`);
      }
    }

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id,
      action: isAdmin ? 'ADMIN_OVERRIDE_APPROVE' : 'APPROVE',
      entity_type: 'attendance', entity_id: record._id,
      old_value: record.status, new_value: 'Approved',
    });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Approved', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/reject', authenticate, authorize('manager', 'admin'), [
  body('remark').notEmpty().withMessage('Rejection reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (req.user.role === 'manager') {
      const empCheck = await User.findOne({ _id: record.emp_id, manager_id: req.user.id }).lean();
      if (!empCheck) return res.status(403).json({ success: false, message: 'Not your team member' });
    }

    const today = istDateStr();
    const isFaceReviewRecord = record.face_verification_status === 'manager_review';
    if (!isFaceReviewRecord && record.status === 'Draft' && record.checkin_time && !record.checkout_time && record.date < today) {
      await AttendanceRecord.findByIdAndUpdate(record._id, {
        $set: { is_missed_checkout: true, status: 'Pending', checkout_remarks: 'Employee did not check out. Requires manager approval.' },
      });
    }

    const update = { status: 'Rejected', manager_remark: remark, actioned_by: req.user.id, actioned_at: new Date() };
    if (record.leave_type) update.leave_status = 'Rejected';
    if (record.face_verification_status === 'manager_review') update.face_verification_status = 'manager_rejected';
    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: update });

    const isFaceReject = record.face_verification_status === 'manager_review';
    const notifTitle = isFaceReject ? 'Check-In Rejected ✗' : record.is_missed_checkout ? 'Missed Check-Out Rejected ✗' : record.leave_type ? 'Leave Rejected ✗' : 'Attendance Rejected ✗';
    const notifMsg   = isFaceReject
      ? `Your check-in for ${record.date} was rejected by your manager: ${remark}`
      : record.is_missed_checkout
        ? `Your missed check-out on ${record.date} was rejected: ${remark}. You may check in again.`
        : record.leave_type ? `Your ${record.leave_type} for ${record.date} was rejected: ${remark}` : `Your attendance for ${record.date} was rejected: ${remark}`;

    await notify(record.emp_id, notifTitle, notifMsg, 'error', record._id, '/employee/history');

    if (record.leave_type) {
      const empUser = await User.findById(record.emp_id).select('email name').lean();
      if (empUser?.email) {
        sendMail(empUser.email, `[AMS] ${record.leave_type} Rejected`,
          `<p>Hi ${empUser.name},</p><p>Your <strong>${record.leave_type}</strong> for <strong>${record.date}</strong> has been <strong style="color:#dc2626">rejected</strong>.</p><p><strong>Reason:</strong> ${remark}</p>`);
      }
    }

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'REJECT', entity_type: 'attendance', entity_id: record._id, old_value: record.status, new_value: 'Rejected' });
    res.json({ success: true, message: 'Rejected' });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/hr-override
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/hr-override', authenticate, authorize('hr', 'super_admin'), async (req, res) => {
  try {
    const { remark } = req.body;
    if (!remark?.trim()) return res.status(400).json({ success: false, message: 'Override remark is required' });
    const rec = await AttendanceRecord.findById(req.params.id).lean();
    if (!rec) return res.status(404).json({ success: false, message: 'Record not found' });
    const role = req.user.role;
    if (rec.overridden_by && rec.overridden_by !== role)
      return res.status(403).json({ success: false, message: `Already overridden by ${rec.overridden_by === 'hr' ? 'HR' : 'Super Admin'}.`, overridden_by: rec.overridden_by });

    const newStatus = rec.status === 'Approved' ? 'Rejected' : 'Approved';
    await AttendanceRecord.findByIdAndUpdate(req.params.id, {
      $set: {
        status: newStatus, hr_override: true,
        hr_remark: `[${role === 'super_admin' ? 'Super Admin' : 'HR'} Override] ${remark.trim()}`,
        override_remark: remark.trim(), overridden_by: role, hr_actioned_at: new Date(),
        ...(rec.leave_type ? { leave_status: newStatus } : {}),
      },
    });
    await notify(rec.emp_id, `Record ${newStatus} by ${role === 'hr' ? 'HR' : 'Super Admin'}`,
      `Your ${rec.leave_type ? 'leave' : 'attendance'} for ${rec.date} was ${newStatus.toLowerCase()} via override.`,
      newStatus === 'Approved' ? 'success' : 'error', rec._id, '/employee/history');
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: `HR_OVERRIDE_${newStatus.toUpperCase()}`, entity_type: 'attendance', entity_id: rec._id, old_value: rec.status, new_value: newStatus });
    res.json({ success: true, message: `Overridden to ${newStatus}` });
  } catch (err) { console.error('[HROverride]', err); res.status(500).json({ success: false, message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/leave-request
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/leave-request', authenticate, authorize('employee'), [
  body('leaveType').isIn(['Casual Leave', 'Half Day', 'Emergency Leave']),
  body('reason').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { leaveType, reason } = req.body;
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (!record.checkout_time) return res.status(400).json({ success: false, message: 'Must checkout before requesting leave' });
    if (record.leave_type) return res.status(409).json({ success: false, message: 'Leave already requested' });

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: { leave_type: leaveType, leave_reason: reason, leave_status: 'Pending' } });

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name email').lean();
      await notify(record.manager_id, `${leaveType} Request`, `${emp.name} requested ${leaveType} for ${record.date}: ${reason}`, 'warning', record._id, '/manager/queue');
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) {
        await sendMail(manager.email, `[AMS] ${leaveType} Request – ${emp.name}`,
          `<p>Hi ${manager.name},</p><p><strong>${emp.name}</strong> submitted a <strong>${leaveType}</strong> for <strong>${record.date}</strong>.</p><p><strong>Reason:</strong> ${reason}</p><p><strong>Worked:</strong> ${record.worked_hours ?? '—'} hrs</p>`);
      }
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'LEAVE_REQUEST', entity_type: 'attendance', entity_id: record._id, new_value: leaveType });
    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Leave request submitted', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/reapply
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/reapply', authenticate, authorize('employee'), reapplyUpload.array('reapplyDocs', 10), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: 'Reason is required' });
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.status !== 'Rejected') return res.status(400).json({ success: false, message: 'Only rejected records can be re-applied' });

    const docPaths = await Promise.all((req.files || []).map(f => uploadFile(f.buffer, `ams/users/${req.user.emp_id || req.user.id}/reapply-docs`, f.originalname, f.mimetype)));
    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: { status: 'Pending', manager_remark: null, reapply_reason: reason.trim(), reapply_docs: docPaths, reapplied_at: new Date(), submitted_at: new Date() },
    });

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name email').lean();
      await notify(record.manager_id, 'Re-application Submitted', `${emp.name} re-submitted attendance for ${record.date}: ${reason}`, 'info', record._id, '/manager/queue');
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) {
        await sendMail(manager.email, `[AMS] Re-application – ${emp.name} (${record.date})`,
          `<p>Hi ${manager.name},</p><p><strong>${emp.name}</strong> re-submitted attendance for <strong>${record.date}</strong>.</p><p><strong>Reason:</strong> ${reason}</p><p><strong>Docs:</strong> ${docPaths.length} file(s)</p>`);
      }
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'REAPPLY', entity_type: 'attendance', entity_id: record._id, new_value: reason });
    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Re-application submitted', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/stats/summary
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, empId } = req.query;
    const match = {};
    if (req.user.role === 'employee') match.emp_id = req.user.id;
    else if (req.user.role === 'manager') {
      if (empId) {
        const emp = await User.findOne({ _id: empId, manager_id: req.user.id }).lean();
        if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });
        match.emp_id = empId;
      } else {
        const teamMembers = await User.find({ manager_id: req.user.id }).select('_id').lean();
        match.emp_id = { $in: teamMembers.map(m => m._id) };
      }
    }
    if (startDate) match.date = { ...match.date, $gte: startDate };
    if (endDate)   match.date = { ...match.date, $lte: endDate };

    const result = await AttendanceRecord.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        total:           { $sum: 1 },
        approved:        { $sum: { $cond: [{ $eq: ['$status', 'Approved']           }, 1, 0] } },
        pending:         { $sum: { $cond: [{ $eq: ['$status', 'Pending']            }, 1, 0] } },
        rejected:        { $sum: { $cond: [{ $eq: ['$status', 'Rejected']           }, 1, 0] } },
        draft:           { $sum: { $cond: [{ $eq: ['$status', 'Draft']              }, 1, 0] } },
        missed_checkout: { $sum: { $cond: [{ $eq: ['$is_missed_checkout', true]     }, 1, 0] } },
        on_duty:         { $sum: { $cond: [{ $eq: ['$duty_type', 'On Duty']         }, 1, 0] } },
        office_duty:     { $sum: { $cond: [{ $eq: ['$duty_type', 'Office Duty']     }, 1, 0] } },
        
        casual_leave:    { $sum: { $cond: [{ $eq: ['$leave_type', 'Casual Leave']   }, 1, 0] } },
        half_day:        { $sum: { $cond: [{ $eq: ['$leave_type', 'Half Day']       }, 1, 0] } },
        emergency_leave: { $sum: { $cond: [{ $eq: ['$leave_type', 'Emergency Leave']}, 1, 0] } },
        total_leaves:    { $sum: { $cond: [{ $ne:  ['$leave_type', null]            }, 1, 0] } },
        lop_count:       { $sum: { $cond: [{ $eq: ['$status', 'Rejected']           }, 1, 0] } },
      }},
      { $project: { _id: 0 } },
    ]);
    const stats = result[0] || { total:0, approved:0, pending:0, rejected:0, draft:0, missed_checkout:0, on_duty:0, office_duty:0, casual_leave:0, half_day:0, emergency_leave:0, total_leaves:0, lop_count:0 };
    res.json({ success: true, data: stats });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scan upload / delete endpoints
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload-scan', authenticate, authorize('employee'), uploadScan.single('scan'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    const day      = istDateStr();
    const dayLabel = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' });
    const currentUser = await User.findById(req.user.id).select('scan_papers').lean();
    const arr         = currentUser?.scan_papers || [];
    const existing    = Array.isArray(arr) ? arr.filter(s => (s.day || s.date) === day) : (arr[day]?.files || []);
    if (existing.length >= 3) return res.status(400).json({ success: false, message: 'Max 2 files already uploaded for today.' });
    const fileIndex = existing.length;
    const scanPath  = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/scans`, req.file.originalname, req.file.mimetype);
    await User.findByIdAndUpdate(req.user.id, {
      $push: { scan_papers: { path: scanPath, day, day_label: dayLabel, file_name: req.file.originalname, file_index: fileIndex, uploaded_at: new Date() } },
    }, { strict: false });
    res.json({ success: true, scanPath, day, dayLabel, fileIndex, totalForDay: fileIndex + 1 });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

router.delete('/clear-scan', authenticate, authorize('employee'), async (req, res) => {
  try {
    const dayParam  = req.query.day || req.query.month || null;
    const fileIndex = req.query.fileIndex !== undefined ? parseInt(req.query.fileIndex, 10) : undefined;
    const u   = await User.findById(req.user.id).select('scan_papers').lean();
    const arr = u?.scan_papers || [];
    if (!Array.isArray(arr)) {
      await User.findByIdAndUpdate(req.user.id, { $set: { scan_papers: [] } }, { strict: false });
      return res.json({ success: true });
    }
    let updated;
    if (dayParam && fileIndex !== undefined)
      updated = arr.filter(s => !((s.day === dayParam || s.date === dayParam || s.month === dayParam) && s.file_index === fileIndex));
    else if (dayParam)
      updated = arr.filter(s => s.day !== dayParam && s.date !== dayParam && s.month !== dayParam);
    else
      updated = [];
    await User.findByIdAndUpdate(req.user.id, { $set: { scan_papers: updated } }, { strict: false });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Signed reports endpoints
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload-signed-report', authenticate, uploadSignedReport.single('signedReport'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: 'Valid month (YYYY-MM) is required' });
    let targetEmpId = req.user.id;
    if (['manager', 'admin', 'hr', 'super_admin'].includes(req.user.role) && req.body.empId) targetEmpId = req.body.empId;
    if (req.user.role === 'employee') {
      const existingUser = await User.findById(targetEmpId).select('signed_reports').lean();
      if ((existingUser?.signed_reports || []).some(r => r.month === month))
        return res.status(409).json({ success: false, message: `A signed report has already been uploaded for ${month}. Contact your admin to replace it.` });
    }
    const monthLabel = new Date(`${month}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const signedPath = await uploadFile(req.file.buffer, `ams/users/${targetEmpId}/signed-reports`, req.file.originalname, req.file.mimetype);
    const entry = { path: signedPath, name: req.file.originalname, month, month_label: monthLabel, uploaded_at: new Date(), uploaded_by: req.user.id };
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 3);
    await User.findByIdAndUpdate(targetEmpId, { $pull: { signed_reports: { uploaded_at: { $lt: cutoff } } } }, { strict: false });
    await User.findByIdAndUpdate(targetEmpId, { $push: { signed_reports: entry } }, { strict: false });
    if (req.user.role === 'employee') {
      const emp = await User.findById(req.user.id).select('name manager_id').lean();
      if (emp?.manager_id) await notify(emp.manager_id, 'Signed Report Uploaded', `${emp.name} uploaded the signed attendance report for ${monthLabel}.`, 'info', null, '/manager/reports');
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'UPLOAD_SIGNED_REPORT', entity_type: 'user', entity_id: targetEmpId, new_value: `${month} signed report` });
    res.status(201).json({ success: true, message: `Signed report uploaded for ${monthLabel}`, path: signedPath, month, monthLabel });
  } catch (err) { console.error('[upload-signed-report]', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

router.delete('/signed-reports/:empId/:month', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { empId, month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: 'Invalid month format (YYYY-MM)' });
    const emp = await User.findById(empId).select('signed_reports manager_id name').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    if (req.user.role === 'manager' && emp.manager_id !== req.user.id)
      return res.status(403).json({ success: false, message: "Not authorized to delete this employee's report" });
    const updated = (emp.signed_reports || []).filter(r => r.month !== month);
    await User.findByIdAndUpdate(empId, { $set: { signed_reports: updated } }, { strict: false });
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'DELETE_SIGNED_REPORT', entity_type: 'user', entity_id: empId, old_value: month });
    res.json({ success: true, message: `Signed report for ${month} deleted` });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/signed-reports/:empId', authenticate, async (req, res) => {
  try {
    const isOwnRequest = req.user.id === req.params.empId;
    if (!isOwnRequest && !['manager', 'admin', 'hr', 'super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    const emp = await User.findById(req.params.empId).select('signed_reports name emp_id').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 3);
    const reports = (emp.signed_reports || [])
      .filter(r => new Date(r.uploaded_at) >= cutoff)
      .map(r => ({ path: r.path, name: r.name, month: r.month, monthLabel: r.month_label, uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by }));
    res.json({ success: true, data: reports });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Format helper
// ─────────────────────────────────────────────────────────────────────────────
function formatRecord(r) {
  return {
    id:                       r._id || r.id,
    empId:                    r.emp_id,
    empName:                  r.emp_name,
    empCode:                  r.emp_code,
    department:               r.department,
    date:                     r.date,
    endDate:                  r.end_date   || null,
    dutyType:                 r.duty_type,
    sector:                   r.sector,
    description:              r.description,
    status:                   r.status,
    selfiePath:               r.selfie_path,
    latitude:                 r.latitude,
    longitude:                r.longitude,
    locationAddress:          r.location_address,
    checkinTime:              r.checkin_time,
    checkoutTime:             r.checkout_time,
    checkoutSelfiePath:       r.checkout_selfie_path,
    checkoutLat:              r.checkout_lat,
    checkoutLng:              r.checkout_lng,
    checkoutLocationAddress:  r.checkout_location_address,
    managerId:                r.manager_id,
    managerName:              r.manager_name,
    managerRemark:            r.manager_remark ? r.manager_remark.replace(/^\[(HR|Super Admin) Override\]\s*/i, '').trim() : '',
    adminRemark:              r.admin_remark,
    actionedBy:               r.actioned_by,
    actionedByName:           r.actioned_by_name,
    actionedAt:               r.actioned_at,
    submittedAt:              r.submitted_at,
    createdAt:                r.created_at,
    workedHours:              r.worked_hours,
    isMissedCheckout:         r.is_missed_checkout || false,
    checkoutRemarks:          r.checkout_remarks,
    leaveType:                r.leave_type,
    leaveReason:              r.leave_reason,
    leaveStatus:              r.leave_status,
    reapplyReason:            r.reapply_reason,
    reapplyDocs:              r.reapply_docs  || [],
    reappliedAt:              r.reapplied_at,
    hrOverride:               r.hr_override   || false,
    hrRemark:                 r.hr_remark     || '',
    overrideRemark:           r.override_remark || '',
    overriddenBy:             r.overridden_by || null,
    hrActionedBy:             r.hr_actioned_by || null,
    hrActionedAt:             r.hr_actioned_at || null,
    faceVerificationStatus:   r.face_verification_status || null,
    faceConfidence:           r.face_confidence ?? null,
    empProfilePhoto:          r.emp_face_photo || r.emp_profile_photo || null,
  };
}

module.exports = router;