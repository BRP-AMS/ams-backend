const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query, body, validationResult } = require('express-validator');
const { Activity, ActivityDocument, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// ── File Upload Config ────────────────────────────────────────────────────
const activityUploadDir = path.join(process.env.UPLOAD_DIR || './uploads', 'activity');
if (!fs.existsSync(activityUploadDir)) fs.mkdirSync(activityUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, activityUploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `act_${req.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits:     { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── Validators ────────────────────────────────────────────────────────────
const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

const activityValidators = [
  body('msme_name').trim().notEmpty().withMessage('MSME name required'),
  body('udyam_number').matches(UDYAM_RE).withMessage('Format: UDYAM-XX-00-0000000'),
  body('sector').isIn(['Manufacturing', 'Services', 'Trade', 'Agriculture', 'Other']),
  body('support_type').isIn(['Awareness', 'Marketing Linkage', 'Loan Facilitation', 'Training/Workshop', 'Advisory/Other']),
  body('block_name').trim().notEmpty().withMessage('Block name required'),
  body('activity_date').isISO8601().toDate(),
];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

// ── Helper: date range from filter ───────────────────────────────────────
const dateRangeFromFilter = (filter, startDate, endDate) => {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const now = new Date();
  const pad = (d) => d.toISOString().slice(0, 10);
  if (filter === 'weekly') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return { start: pad(d), end: pad(now) };
  }
  if (filter === 'biweekly') {
    const d = new Date(now); d.setDate(d.getDate() - 14);
    return { start: pad(d), end: pad(now) };
  }
  // monthly (default)
  return { start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, end: pad(now) };
};

// ── POST /api/activity ─────────────────────────────────────────────────
// Create a new MSME activity record with optional document uploads
router.post('/', authenticate, upload.array('documents', 10), activityValidators, validate, async (req, res) => {
  try {
    const { msme_name, udyam_number, sector, support_type, block_name, latitude, longitude, location_address, activity_date, remarks } = req.body;

    const id = uuidv4();
    await Activity.create({
      _id:              id,
      user_id:          req.user.id,
      msme_name,
      udyam_number,
      sector,
      support_type,
      block_name,
      latitude:         latitude         || null,
      longitude:        longitude        || null,
      location_address: location_address || null,
      activity_date:    typeof activity_date === 'string' ? activity_date : activity_date.toISOString().slice(0, 10),
      remarks:          remarks          || null,
    });

    // Save uploaded documents
    if (req.files?.length) {
      await ActivityDocument.insertMany(req.files.map(f => ({
        _id:         uuidv4(),
        activity_id: id,
        file_path:   f.filename,
        file_name:   f.originalname,
        file_type:   f.mimetype,
      })));
    }

    res.status(201).json({ success: true, data: { id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity ──────────────────────────────────────────────────
// Employee: own; Manager/Admin: all with filters
router.get('/', authenticate, [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('block').optional().trim(),
  query('sector').optional().trim(),
  query('support_type').optional().trim(),
], validate, async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate, block, sector, support_type, limit = 100, offset = 0 } = req.query;
    const { start, end } = dateRangeFromFilter(filter, startDate, endDate);

    const matchFilter = { activity_date: { $gte: start, $lte: end } };
    if (req.user.role === 'employee') matchFilter.user_id = req.user.id;
    if (block)        matchFilter.block_name   = block;
    if (sector)       matchFilter.sector       = sector;
    if (support_type) matchFilter.support_type = support_type;

    const total = await Activity.countDocuments(matchFilter);

    const rows = await Activity.aggregate([
      { $match: matchFilter },
      { $lookup: { from: 'users',             localField: 'user_id',  foreignField: '_id', as: 'user'      } },
      { $lookup: { from: 'activitydocuments', localField: '_id',      foreignField: 'activity_id', as: 'docs' } },
      { $addFields: {
          user_name: { $arrayElemAt: ['$user.name',   0] },
          emp_id:    { $arrayElemAt: ['$user.emp_id', 0] },
          doc_count: { $size: '$docs' },
      }},
      { $project: { user: 0, docs: 0 } },
      { $sort: { activity_date: -1, created_at: -1 } },
      { $skip: Number(offset) },
      { $limit: Number(limit) },
    ]);

    res.json({ success: true, data: rows, total, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/:id ──────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const rows = await Activity.aggregate([
      { $match: { _id: req.params.id } },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $addFields: {
          user_name: { $arrayElemAt: ['$user.name',   0] },
          emp_id:    { $arrayElemAt: ['$user.emp_id', 0] },
      }},
      { $project: { user: 0 } },
    ]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const row = rows[0];

    if (req.user.role === 'employee' && row.user_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Forbidden' });

    const docs = await ActivityDocument.find({ activity_id: row._id }).lean();
    res.json({ success: true, data: { ...row, documents: docs } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/heatmap ───────────────────────────────────
// Returns {date, count} for calendar heatmap
router.get('/stats/heatmap', authenticate, authorize('admin', 'manager'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate } = req.query;
    const { start, end } = dateRangeFromFilter(filter, startDate, endDate);

    const rows = await Activity.aggregate([
      { $match: { activity_date: { $gte: start, $lte: end } } },
      { $group: { _id: '$activity_date', count: { $sum: 1 } } },
      { $project: { _id: 0, date: '$_id', count: 1 } },
      { $sort: { date: 1 } },
    ]);

    res.json({ success: true, data: rows, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/block-wise ────────────────────────────────
// Block-level aggregation for admin dashboard
router.get('/stats/block-wise', authenticate, authorize('admin', 'manager'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate } = req.query;
    const { start, end } = dateRangeFromFilter(filter, startDate, endDate);

    const rows = await Activity.aggregate([
      { $match: { activity_date: { $gte: start, $lte: end } } },
      { $group: {
        _id:          '$block_name',
        total:        { $sum: 1 },
        incubation:   { $sum: { $cond: [{ $eq: ['$support_type', 'Incubation']    }, 1, 0] } },
        market_linkage:{ $sum: { $cond: [{ $eq: ['$support_type', 'Market Linkage']}, 1, 0] } },
        advisory:     { $sum: { $cond: [{ $eq: ['$support_type', 'Advisory']      }, 1, 0] } },
        user_ids:     { $addToSet: '$user_id' },
        msme_names:   { $addToSet: '$msme_name' },
      }},
      { $project: {
        _id:          0,
        block_name:   '$_id',
        total:        1,
        incubation:   1,
        market_linkage: 1,
        advisory:     1,
        active_users: { $size: '$user_ids' },
        unique_msme:  { $size: '$msme_names' },
      }},
      { $sort: { total: -1 } },
    ]);

    res.json({ success: true, data: rows, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/compliance ───────────────────────────────
// Monthly compliance: users who submitted at least N activities this month
router.get('/stats/compliance', authenticate, authorize('admin', 'manager'), async (req, res) => {
  try {
    const now        = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd   = now.toISOString().slice(0, 10);

    const rows = await User.aggregate([
      { $match: { role: 'employee', is_active: 1 } },
      {
        $lookup: {
          from:     'activities',
          let:      { uid: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq:  ['$user_id',       '$$uid'     ] },
              { $gte: ['$activity_date', monthStart  ] },
              { $lte: ['$activity_date', monthEnd    ] },
            ]}}}
          ],
          as: 'activities',
        },
      },
      {
        $project: {
          emp_id:     1,
          name:       1,
          department: 1,
          activity_count: { $size: '$activities' },
          compliance_status: {
            $cond: [{ $gte: [{ $size: '$activities' }, 4] }, 'Compliant', 'Non-Compliant']
          },
        },
      },
      { $sort: { activity_count: -1 } },
    ]);

    res.json({ success: true, data: rows, month: monthStart.slice(0, 7) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/report/excel ────────────────────────────────────
router.get('/report/excel', authenticate, authorize('admin', 'manager', 'employee'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'all']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { filter = 'monthly', startDate, endDate } = req.query;
    const isEmployee = req.user.role === 'employee';

    const matchFilter = isEmployee ? { user_id: req.user.id } : {};
    if (filter !== 'all') {
      const { start, end } = dateRangeFromFilter(filter, startDate, endDate);
      matchFilter.activity_date = { $gte: start, $lte: end };
    }

    const rows = await Activity.aggregate([
      { $match: matchFilter },
      { $lookup: { from: 'users',             localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $lookup: { from: 'activitydocuments', localField: '_id',     foreignField: 'activity_id', as: 'docs' } },
      { $addFields: {
          emp_id:    { $arrayElemAt: ['$user.emp_id', 0] },
          user_name: { $arrayElemAt: ['$user.name',   0] },
          doc_count: { $size: '$docs' },
      }},
      { $sort: { activity_date: -1 } },
    ]);

    const excelRows = rows.map(a => ({
      'Date':          a.activity_date,
      'Emp ID':        a.emp_id,
      'Officer Name':  a.user_name,
      'MSME Name':     a.msme_name,
      'Udyam No':      a.udyam_number,
      'Sector':        a.sector,
      'Support Type':  a.support_type,
      'Block':         a.block_name,
      'Location':      a.location_address,
      'Remarks':       a.remarks,
      'Docs':          a.doc_count,
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excelRows), 'Activities');

    // Block-wise summary sheet
    const blockRows = await Activity.aggregate([
      { $match: matchFilter },
      { $group: {
        _id:               '$block_name',
        total:             { $sum: 1 },
        awareness:         { $sum: { $cond: [{ $eq: ['$support_type', 'Awareness']         }, 1, 0] } },
        marketing_linkage: { $sum: { $cond: [{ $eq: ['$support_type', 'Marketing Linkage'] }, 1, 0] } },
        loan_facilitation: { $sum: { $cond: [{ $eq: ['$support_type', 'Loan Facilitation'] }, 1, 0] } },
        training_workshop: { $sum: { $cond: [{ $eq: ['$support_type', 'Training/Workshop'] }, 1, 0] } },
        advisory_other:    { $sum: { $cond: [{ $eq: ['$support_type', 'Advisory/Other']    }, 1, 0] } },
      }},
      { $project: { _id: 0, 'Block': '$_id', 'Total': '$total', 'Awareness': '$awareness', 'Marketing Linkage': '$marketing_linkage', 'Loan Facilitation': '$loan_facilitation', 'Training/Workshop': '$training_workshop', 'Advisory/Other': '$advisory_other' } },
      { $sort: { Total: -1 } },
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(blockRows), 'Block Summary');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const excelFilename = filter === 'all' ? `activities_all.xlsx` : `activities_${matchFilter.activity_date?.$gte}_${matchFilter.activity_date?.$lte}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename=${excelFilename}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/report/pdf ──────────────────────────────────────
router.get('/report/pdf', authenticate, authorize('admin', 'manager', 'employee'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'all']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { filter = 'monthly', startDate, endDate } = req.query;
    const isEmployee = req.user.role === 'employee';

    const matchFilter = isEmployee ? { user_id: req.user.id } : {};
    if (filter !== 'all') {
      const { start, end } = dateRangeFromFilter(filter, startDate, endDate);
      matchFilter.activity_date = { $gte: start, $lte: end };
    }

    const rows = await Activity.aggregate([
      { $match: matchFilter },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $addFields: { officer: { $arrayElemAt: ['$user.name', 0] } } },
      { $project: { user: 0 } },
      { $sort: { activity_date: -1 } },
      { $limit: 500 },
    ]);

    const blockStats = await Activity.aggregate([
      { $match: matchFilter },
      { $group: { _id: '$block_name', total: { $sum: 1 } } },
      { $project: { _id: 0, block_name: '$_id', total: 1 } },
      { $sort: { total: -1 } },
    ]);

    const pdfFilename = filter === 'all' ? 'activity_report_all.pdf' : `activity_report_${matchFilter.activity_date?.$gte}_${matchFilter.activity_date?.$lte}.pdf`;
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Disposition', `attachment; filename=${pdfFilename}`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('BRP — Activity Report', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text(`Period: ${start} to ${end}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.5);

    // Summary
    doc.fontSize(13).font('Helvetica-Bold').text('Block-wise Summary');
    doc.moveDown(0.3);
    const colW   = [200, 80];
    const startX = 40;
    let y = doc.y;
    doc.fontSize(10).font('Helvetica-Bold')
      .text('Block', startX, y).text('Total', startX + colW[0], y);
    y += 18;
    doc.font('Helvetica');
    for (const b of blockStats) {
      doc.text(b.block_name, startX, y).text(String(b.total), startX + colW[0], y);
      y += 16;
      if (y > 750) { doc.addPage(); y = 40; }
    }
    doc.moveDown(1);

    // Detail table
    doc.fontSize(13).font('Helvetica-Bold').text('Activity Details', 40, doc.y);
    doc.moveDown(0.3);
    const cols    = [70, 100, 120, 80, 100, 80];
    const headers = ['Date', 'Officer', 'MSME Name', 'Sector', 'Support', 'Block'];
    y = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    let x = 40;
    headers.forEach((h, i) => { doc.text(h, x, y, { width: cols[i] }); x += cols[i]; });
    y += 16;
    doc.font('Helvetica').fontSize(8);

    for (const r of rows) {
      if (y > 760) { doc.addPage(); y = 40; }
      x = 40;
      [r.activity_date, r.officer, r.msme_name, r.sector, r.support_type, r.block_name].forEach((v, i) => {
        doc.text(String(v || ''), x, y, { width: cols[i] - 2, ellipsis: true });
        x += cols[i];
      });
      y += 14;
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
