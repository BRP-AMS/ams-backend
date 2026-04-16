const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const XLSX     = require('xlsx');
const { uploadFile } = require('../utils/storage');
const { v4: uuidv4 } = require('uuid');
const { ActivitySchedule, ScheduleDocument, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// For completion attachments (memory storage → Cloudinary)
const SCHED_ALLOWED_EXT = /^\.(jpe?g|png|gif|pdf|docx?|xlsx)$/i;
const SCHED_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const uploadAttach = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!SCHED_ALLOWED_EXT.test(ext))           return cb(new Error('File extension not allowed'));
    if (!SCHED_ALLOWED_MIME.has(file.mimetype)) return cb(new Error('File MIME type not allowed'));
    cb(null, true);
  },
});

// For bulk Excel/CSV upload
const BULK_ALLOWED_EXT = /^\.(xlsx|xls|csv)$/i;
const BULK_ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/octet-stream', // some browsers report this for xlsx
]);
const bulkStorage = multer.memoryStorage();
const uploadBulk  = multer({
  storage: bulkStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!BULK_ALLOWED_EXT.test(ext))           return cb(new Error('Only .xlsx, .xls or .csv files allowed'));
    if (!BULK_ALLOWED_MIME.has(file.mimetype)) return cb(new Error('Declared MIME type not allowed'));
    cb(null, true);
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
      id:                s._id,
      created_by_name:   userMap[s.created_by]?.name   || null,
      assigned_to_name:  userMap[s.assigned_to]?.name  || null,
      assigned_to_empid: userMap[s.assigned_to]?.emp_id || null,
      initiated_by_name: userMap[s.initiated_by]?.name || null,
      completed_by_name: userMap[s.completed_by]?.name || null,
      documents:         docsMap[s._id] || [],
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
router.post('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { title, description, scheduled_date, location, assigned_emp_id } = req.body;
    if (!title?.trim())      return res.status(422).json({ success: false, message: 'Title is required' });
    if (!scheduled_date)     return res.status(422).json({ success: false, message: 'Scheduled date is required' });

    let assigned_to = null;
    if (assigned_emp_id) {
      const emp = await User.findOne({ emp_id: assigned_emp_id }).select('_id').lean();
      if (!emp) return res.status(404).json({ success: false, message: `Employee ${assigned_emp_id} not found` });
      assigned_to = emp._id;
    }

    const schedule = await ActivitySchedule.create({
      _id:            uuidv4(),
      title:          title.trim(),
      description:    description?.trim() || null,
      scheduled_date,
      location:       location?.trim() || null,
      assigned_to,
      created_by:     req.user.id,
    });

    res.status(201).json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    console.error('POST /activity-schedule error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
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

        let assigned_to = null;
        if (assigned_emp_id) {
          const emp = await User.findOne({ emp_id: assigned_emp_id }).select('_id').lean();
          if (!emp) { errors.push(`Row ${rowNum}: employee "${assigned_emp_id}" not found`); continue; }
          assigned_to = emp._id;
        }

        toInsert.push({
          _id:            uuidv4(),
          title,
          description,
          scheduled_date,
          location,
          assigned_to,
          created_by:     req.user.id,
        });
      }

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

    // Save attachments to Cloudinary
    if (req.files?.length) {
      const urls = await Promise.all(
        req.files.map(f => uploadFile(f.buffer, 'ams/schedule-docs', f.originalname, f.mimetype))
      );
      await ScheduleDocument.insertMany(urls.map((url, i) => ({
        _id:         uuidv4(),
        schedule_id: schedule._id,
        file_path:   url,
        file_name:   req.files[i].originalname,
        file_type:   req.files[i].mimetype,
      })));
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

    // Files are on Cloudinary — just remove DB records
    await ScheduleDocument.deleteMany({ schedule_id: req.params.id });
    await schedule.deleteOne();

    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
