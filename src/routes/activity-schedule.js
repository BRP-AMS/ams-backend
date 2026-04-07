const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const XLSX     = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { ActivitySchedule, ScheduleDocument, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// ── Upload directories ────────────────────────────────────────────────────
const scheduleUploadDir = path.join(process.env.UPLOAD_DIR || './uploads', 'schedule');
if (!fs.existsSync(scheduleUploadDir)) fs.mkdirSync(scheduleUploadDir, { recursive: true });

// For completion attachments
const attachStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, scheduleUploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `sched_${req.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const uploadAttach = multer({
  storage: attachStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});


const PDFDocument = require("pdfkit");

router.get("/report/pdf", authenticate, async (req, res) => {
  try {
    const { filter } = req.query;

    const query = {};

    // apply filter
    if (filter === "monthly") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      query.scheduled_date = {
        $gte: start.toISOString().slice(0, 10),
        $lte: end.toISOString().slice(0, 10),
      };
    }

    const activities = await ActivitySchedule.find(query).lean();

    const doc = new PDFDocument({ margin: 30 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=activities.pdf"
    );

    doc.pipe(res);

    doc.fontSize(18).text("Activity Report", { align: "center" });
    doc.moveDown();

    if (!activities.length) {
      doc.fontSize(12).text("No activities found");
    } else {
      activities.forEach((a, i) => {
        doc
          .fontSize(12)
          .text(`${i + 1}. ${a.title || "-"}`)
          .text(`Location: ${a.location || "-"}`)
          .text(`Date: ${a.scheduled_date || "-"}`)
          .text(`Status: ${a.status || "-"}`)
          .moveDown();
      });
    }

    doc.end();
  } catch (err) {
    console.error("PDF export error:", err);

    res.status(500).json({
      success: false,
      message: "PDF export failed",
    });
  }
});

// For bulk Excel/CSV upload
const bulkStorage = multer.memoryStorage();
const uploadBulk  = multer({
  storage: bulkStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = /xlsx|xls|csv/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
  },
});

// ── GET /activity-schedule — list all (employees see all) ─────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, date_from, date_to, assigned_to, created_by } = req.query;
    const filter = {};

    if (status)      filter.status         = status;
    if (assigned_to) filter.assigned_to    = assigned_to;
    if (created_by)  filter.created_by     = created_by;
    if (date_from || date_to) {
      filter.scheduled_date = {};
      if (date_from) filter.scheduled_date.$gte = date_from;
      if (date_to)   filter.scheduled_date.$lte = date_to;
    }

    const schedules = await ActivitySchedule.find(filter)
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    // Populate creator, assigned_to, initiated_by, completed_by names
    const userIds = new Set();
    schedules.forEach(s => {
      if (s.created_by)   userIds.add(s.created_by);
      if (s.assigned_to)  userIds.add(s.assigned_to);
      if (s.initiated_by) userIds.add(s.initiated_by);
      if (s.completed_by) userIds.add(s.completed_by);
    });

    const users = await User.find({ _id: { $in: [...userIds] } })
      .select('_id name emp_id')
      .lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id] = { name: u.name, emp_id: u.emp_id }; });

    // Attach documents for completed schedules
    const completedIds = schedules.filter(s => s.status === 'Completed').map(s => s._id);
    const docs = completedIds.length
      ? await ScheduleDocument.find({ schedule_id: { $in: completedIds } }).lean()
      : [];
    const docsMap = {};
    docs.forEach(d => {
      if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = [];
      docsMap[d.schedule_id].push(d);
    });

   const result = schedules.map(s => ({
  ...s,
  id: s._id,
  created_by_name: userMap[s.created_by]?.name || null,
  assigned_to_name: userMap[s.assigned_to]?.name || s.employee_name || null,
  assigned_to_empid: userMap[s.assigned_to]?.emp_id || null,
  manager_name: s.manager_name || userMap[s.created_by]?.name || null,
  initiated_by_name: userMap[s.initiated_by]?.name || null,
  completed_by_name: userMap[s.completed_by]?.name || null,
  documents: docsMap[s._id] || [],
}));
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /activity-schedule error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /activity-schedule/my-completed — employee's completed schedules ──
router.get('/my-completed', authenticate, async (req, res) => {
  try {
    const schedules = await ActivitySchedule.find({ completed_by: req.user.id })
      .sort({ completed_at: -1 })
      .lean();

    const ids  = schedules.map(s => s._id);
    const docs = ids.length
      ? await ScheduleDocument.find({ schedule_id: { $in: ids } }).lean()
      : [];
    const docsMap = {};
    docs.forEach(d => {
      if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = [];
      docsMap[d.schedule_id].push(d);
    });

    const result = schedules.map(s => ({ ...s, id: s._id, documents: docsMap[s._id] || [] }));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /activity-schedule — create single (manager/admin) ───────────────
router.post('/', authenticate, async (req, res) => {
  try {

    const {
      title,
      description,
      scheduled_date,
      location,
      assigned_emp_id
    } = req.body;

    let employee_name = null;
    let manager_name = req.user.name;

    let assigned_to = null;

    if (assigned_emp_id) {
      const emp = await User.findOne({ emp_id: assigned_emp_id }).lean();

      if (emp) {
        assigned_to = emp._id;
        employee_name = emp.name;
      }
    }

    const schedule = await ActivitySchedule.create({
      _id: uuidv4(),
      title,
      description,
      scheduled_date,
      location,
      assigned_to,
      employee_name,
      manager_name,
      assigned_by: req.user.name,
      created_by: req.user.id
    });

    res.status(201).json({
      success: true,
      data: schedule
    });

  } catch (error) {
    res.status(500).json({
      message: error.message
    });
  }
});

// ── POST /activity-schedule/bulk — bulk upload via Excel/CSV ──────────────
router.post('/bulk', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'),
  uploadBulk.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length) return res.status(422).json({ success: false, message: 'Excel file is empty' });

      const errors   = [];
      const toInsert = [];

      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2; // 1-indexed + header row
        const title  = String(row['title'] || row['Title'] || '').trim();
        const dateRaw = String(row['scheduled_date'] || row['Scheduled Date'] || row['date'] || '').trim();
        const location       = String(row['location']        || row['Location']        || '').trim() || null;
        const description    = String(row['description']     || row['Description']     || '').trim() || null;
        const assigned_emp_id = String(row['assigned_emp_id'] || row['Assigned Emp ID'] || row['emp_id'] || '').trim() || null;

        if (!title)   { errors.push(`Row ${rowNum}: title is required`);          continue; }
        if (!dateRaw) { errors.push(`Row ${rowNum}: scheduled_date is required`); continue; }

        // Parse date — accept YYYY-MM-DD or Excel serial numbers
        let scheduled_date = dateRaw;
        if (/^\d{5}$/.test(dateRaw)) {
          // Excel serial date
          const jsDate = XLSX.SSF.parse_date_code(Number(dateRaw));
          scheduled_date = `${jsDate.y}-${String(jsDate.m).padStart(2,'0')}-${String(jsDate.d).padStart(2,'0')}`;
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
          errors.push(`Row ${rowNum}: scheduled_date must be YYYY-MM-DD (got: ${dateRaw})`);
          continue;
        }

       
let employee_name = null;

if (assigned_emp_id) {
  const emp = await User.findOne({ emp_id: assigned_emp_id }).lean();
  if (!emp) {
    errors.push(`Row ${rowNum}: employee "${assigned_emp_id}" not found`);
    continue;
  }

  assigned_to = emp._id;
  employee_name = emp.name;
}

toInsert.push({
  _id: uuidv4(),
  title,
  description,
  scheduled_date,
  location,
  assigned_to,
  employee_name,
  manager_name: req.user.name,
  assigned_by: req.user.name,
  created_by: req.user.id,
});
      let inserted = [];
      if (toInsert.length) {
        inserted = await ActivitySchedule.insertMany(toInsert);
      }

      res.json({
        success:  true,
        inserted: inserted.length,
        skipped:  errors.length,
        errors,
        message:  `${inserted.length} schedule(s) created${errors.length ? `, ${errors.length} row(s) skipped` : ''}`,
      });
    } catch (err) {
      console.error('POST /activity-schedule/bulk error:', err);
      res.status(500).json({ success: false, message: 'Failed to parse file: ' + err.message });
    }
  }
);

// ── GET /activity-schedule/template — download blank Excel template ────────
router.get('/template', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['title', 'description', 'scheduled_date', 'location', 'assigned_emp_id'],
    ['Block Visit - Araria', 'Awareness camp for MSMEs', '2025-04-10', 'Araria Block', 'EMP001'],
    ['Training Workshop', 'Loan facilitation training', '2025-04-15', 'District HQ', ''],
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 40 }, { wch: 18 }, { wch: 25 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedules');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="schedule_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── PUT /activity-schedule/:id/initiate — employee initiates ─────────────
router.put('/:id/initiate', authenticate, async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (schedule.status !== 'Pending')
      return res.status(409).json({ success: false, message: 'Schedule is already initiated or completed' });

    // If assigned to a specific employee, only that employee can initiate
    if (schedule.assigned_to && schedule.assigned_to !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This schedule is assigned to another employee' });
    }

    schedule.status       = 'Initiated';
    schedule.initiated_by = req.user.id;
    schedule.initiated_at = new Date();
    await schedule.save();

    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /activity-schedule/:id/complete — employee completes ──────────────
router.put('/:id/complete', authenticate, uploadAttach.array('attachments', 10), async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (schedule.status === 'Completed')
      return res.status(409).json({ success: false, message: 'Schedule already completed' });
    if (schedule.status !== 'Initiated')
      return res.status(409).json({ success: false, message: 'Initiate the schedule before completing' });
    if (schedule.initiated_by.toString() !== req.user.id)
      return res.status(403).json({ success: false, message: 'Only the employee who initiated can complete' });

    const { work_description, remarks } = req.body;
    if (!work_description?.trim())
      return res.status(422).json({ success: false, message: 'Work description is required' });

    schedule.status           = 'Completed';
    schedule.completed_by     = req.user.id;
    schedule.completed_at     = new Date();
    schedule.work_description = work_description.trim();
    schedule.remarks          = remarks?.trim() || null;
    await schedule.save();

    // Save attachments
    if (req.files?.length) {
      const docs = req.files.map(f => ({
        _id:         uuidv4(),
        schedule_id: schedule._id,
        file_path:   `schedule/${f.filename}`,
        file_name:   f.originalname,
        file_type:   f.mimetype,
      }));
      await ScheduleDocument.insertMany(docs);
    }

    const documents = await ScheduleDocument.find({ schedule_id: schedule._id }).lean();
    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id, documents } });
  } catch (err) {
    console.error('PUT /complete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /activity-schedule/:id — manager/admin deletes ────────────────
router.delete('/:id', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });

    // Remove attached files
    const docs = await ScheduleDocument.find({ schedule_id: req.params.id }).lean();
    docs.forEach(d => {
      const fp = path.join(process.env.UPLOAD_DIR || './uploads', d.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    await ScheduleDocument.deleteMany({ schedule_id: req.params.id });
    await schedule.deleteOne();

    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


router.get('/export/excel', authenticate, async (req, res) => {
  try {
    const { status, created_by, startDate, endDate } = req.query;

    const filter = {};

    if (status) filter.status = status;
    if (created_by) filter.created_by = created_by;

    // ✅ added date filtering for custom export
    if (startDate || endDate) {
      filter.scheduled_date = {};
      if (startDate) filter.scheduled_date.$gte = startDate;
      if (endDate) filter.scheduled_date.$lte = endDate;
    }

    const schedules = await ActivitySchedule.find(filter).lean();

    const rows = schedules.map(s => ({
      Title: s.title,
      Description: s.description || '',
      Date: s.scheduled_date,
      Location: s.location || '',
      Employee: s.employee_name || '',
      Manager: s.manager_name || '',
      Status: s.status
    }));

    const ws = XLSX.utils.json_to_sheet(rows);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Schedules');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="schedules.xlsx"'
    );

    res.send(buffer);

  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ success:false, message:'Excel export failed' });
  }
});

module.exports = router;
