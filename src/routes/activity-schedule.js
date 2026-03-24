const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const XLSX     = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { ActivitySchedule, ScheduleDocument, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');
const { scheduleUploader, bulkExcelUploader, deleteFromCloudinary } = require('../config/cloudinary');
 
// ── Multer uploaders (Cloudinary) ────────────────────────────────────────
const uploadAttach = scheduleUploader;   // .array('attachments', 10) — goes to Cloudinary
const uploadBulk   = bulkExcelUploader; // .single('file')            — stays in memory

// ── Upload directories ────────────────────────────────────────────────────
// const scheduleUploadDir = path.join(process.env.UPLOAD_DIR || './uploads', 'schedule');
// if (!fs.existsSync(scheduleUploadDir)) fs.mkdirSync(scheduleUploadDir, { recursive: true });

// const attachStorage = multer.diskStorage({
//   destination: (req, file, cb) => cb(null, scheduleUploadDir),
//   filename:    (req, file, cb) => {
//     const ext = path.extname(file.originalname);
//     cb(null, `sched_${req.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
//   },
// });
// const uploadAttach = multer({
//   storage: attachStorage,
//   limits: { fileSize: 10 * 1024 * 1024, files: 10 },
//   fileFilter: (req, file, cb) => {
//     const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
//     if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
//     else cb(new Error('File type not allowed'));
//   },
// });

// const uploadBulk = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 5 * 1024 * 1024, files: 1 },
//   fileFilter: (req, file, cb) => {
//     const allowed = /xlsx|xls|csv/;
//     if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
//     else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
//   },
// });

// ── Helper: resolve user map ──────────────────────────────────────────────
const resolveUsers = async (schedules) => {
  const userIds = new Set();
  schedules.forEach(s => {
    if (s.created_by)   userIds.add(s.created_by);
    if (s.assigned_to)  userIds.add(s.assigned_to);
    if (s.manager_id)   userIds.add(s.manager_id);
    if (s.initiated_by) userIds.add(s.initiated_by);
    if (s.completed_by) userIds.add(s.completed_by);
  });
  const users = await User.find({ _id: { $in: [...userIds] } }).select('_id name emp_id').lean();
  const map = {};
  users.forEach(u => { map[u._id] = { name: u.name, emp_id: u.emp_id }; });
  return map;
};

// ── Helper: build filter from query ──────────────────────────────────────
const buildFilter = async (query) => {
  const { status, date_from, date_to, assigned_to, manager_team } = query;
  const filter = {};

  if (status === 'Initiated') {
    filter.$or = [
      { status: 'Initiated' },
      { status: 'Pending', assigned_to: { $ne: null } },
    ];
  } else if (status) {
    filter.status = status;
  }

  if (assigned_to) filter.assigned_to = assigned_to;

  if (date_from || date_to) {
    filter.scheduled_date = {};
    if (date_from) filter.scheduled_date.$gte = date_from;
    if (date_to)   filter.scheduled_date.$lte = date_to;
  }

  if (manager_team) {
    const team    = await User.find({ manager_id: manager_team, is_active: 1 }).select('_id').lean();
    const teamIds = team.map(m => m._id);
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { assigned_to: { $in: teamIds } }];
      delete filter.$or;
    } else {
      filter.assigned_to = { $in: teamIds };
    }
  }

  return filter;
};
// ── GET /activity-schedule ────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const filter    = await buildFilter(req.query);
    const schedules = await ActivitySchedule.find(filter)
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    const userMap = await resolveUsers(schedules);

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
      id:                 s._id,
      manager_name:       userMap[s.manager_id]?.name    || null,
      manager_empid:      userMap[s.manager_id]?.emp_id  || null,
      created_by_name:    userMap[s.created_by]?.name    || null,
      created_by_empid:   userMap[s.created_by]?.emp_id  || null,
      assigned_to_name:   userMap[s.assigned_to]?.name   || null,
      assigned_to_empid:  userMap[s.assigned_to]?.emp_id || null,
      initiated_by_name:  userMap[s.initiated_by]?.name  || null,
      initiated_by_empid: userMap[s.initiated_by]?.emp_id|| null,
      completed_by_name:  userMap[s.completed_by]?.name  || null,
      completed_by_empid: userMap[s.completed_by]?.emp_id|| null,
      documents:          docsMap[s._id] || [],
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /activity-schedule error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /activity-schedule/my-completed ──────────────────────────────────
router.get('/my-completed', authenticate, async (req, res) => {
  try {
    const schedules = await ActivitySchedule.find({ completed_by: req.user.id })
      .sort({ completed_at: -1 }).lean();
    const ids  = schedules.map(s => s._id);
    const docs = ids.length
      ? await ScheduleDocument.find({ schedule_id: { $in: ids } }).lean()
      : [];
    const docsMap = {};
    docs.forEach(d => {
      if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = [];
      docsMap[d.schedule_id].push(d);
    });
    res.json({
      success: true,
      data: schedules.map(s => ({ ...s, id: s._id, documents: docsMap[s._id] || [] })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /activity-schedule/template ──────────────────────────────────────
router.get('/template', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const managers   = await User.find({ role: 'manager', is_active: 1 }).select('name emp_id').lean();
    const me         = await User.findById(req.user.id).select('name').lean();
    const assignedBy = me?.name || 'Super Admin';
    const mgr1       = managers[0]?.name || 'Manager One';
    const mgr2       = managers[1]?.name || managers[0]?.name || 'Manager One';

    const wb = XLSX.utils.book_new();

    const templateData = [
      ['title',            'description',               'scheduled_date', 'location',      'manager_name', 'assigned_emp_id', 'assigned_by'],
      ['Block Visit - A',  'Awareness camp for MSMEs',  '2025-04-10',     'Araria Block',  mgr1,           'EMP001',          assignedBy],
    ];
    const ws = XLSX.utils.aoa_to_sheet(templateData);
    ws['!cols'] = [
      { wch: 28 }, { wch: 35 }, { wch: 16 }, { wch: 20 },
      { wch: 20 }, { wch: 18 }, { wch: 16 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Schedule Template');

    const rulesData = [
      ['Field in Form',  'Excel Column',    'Required', 'Notes'],
      ['Title',          'title',           'YES',      'Schedule title'],
      ['Description',    'description',     'NO',       'Optional description'],
      ['Scheduled Date', 'scheduled_date',  'YES',      'Format: YYYY-MM-DD (e.g. 2025-04-10)'],
      ['Location',       'location',        'NO',       'Venue or location name'],
      ['Manager Name',   'manager_name',    'YES',      'Required. Manager full name — must match exactly in system.'],
      ['Employee Name',  'assigned_emp_id', 'YES',      'Required. Employee emp_id (e.g. EMP001) — must exist in system.'],
      ['Assigned By',    'assigned_by',     'AUTO',     'Auto-set to logged-in user. Value in Excel is ignored.'],
    ];
    const wsRules = XLSX.utils.aoa_to_sheet(rulesData);
    wsRules['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 10 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, wsRules, 'Field Guide');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="schedule_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ── POST /activity-schedule ───────────────────────────────────────────────
router.post('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { title, description, scheduled_date, location, assigned_emp_id, manager_id } = req.body;
    if (!title?.trim())  return res.status(422).json({ success: false, message: 'Title is required' });
    if (!scheduled_date) return res.status(422).json({ success: false, message: 'Scheduled date is required' });

    // Resolve employee
    let assigned_to = null;
    if (assigned_emp_id) {
      const emp = await User.findOne({
        $or: [{ _id: assigned_emp_id }, { emp_id: assigned_emp_id }],
      }).select('_id').lean();
      if (!emp) return res.status(404).json({ success: false, message: `Employee ${assigned_emp_id} not found` });
      assigned_to = emp._id;
    }

    // Resolve manager — use provided manager_id or look up from assigned employee
    let resolvedManagerId = manager_id || null;
    if (!resolvedManagerId && assigned_to) {
      const empUser = await User.findById(assigned_to).select('manager_id').lean();
      resolvedManagerId = empUser?.manager_id || null;
    }

    const schedule = await ActivitySchedule.create({
      _id:         uuidv4(),
      title:       title.trim(),
      description: description?.trim() || null,
      scheduled_date,
      location:    location?.trim() || null,
      assigned_to,
      manager_id:  resolvedManagerId,
      created_by:  req.user.id,
    });

    res.status(201).json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    console.error('POST /activity-schedule error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /activity-schedule/bulk ─────────────────────────────────────────
router.post('/bulk', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'),
  uploadBulk.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const rows     = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
      if (!rows.length) return res.status(422).json({ success: false, message: 'Excel file is empty' });

      const errors = []; const toInsert = [];

      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2;

        const title            = String(row['title']          || row['Title']           || '').trim();
        const dateRaw          = String(row['scheduled_date'] || row['Scheduled Date']  || '').trim();
        const location         = String(row['location']       || row['Location']        || '').trim() || null;
        const description      = String(row['description']    || row['Description']     || '').trim() || null;
        const assigned_emp_id  = String(row['assigned_emp_id']|| row['Assigned Emp ID'] || row['emp_id'] || '').trim() || null;
        const manager_name_raw = String(row['manager_name']   || row['Manager Name']    || row['manager'] || '').trim() || null;
        // assigned_by is always ignored — set to req.user.id

        if (!title)   { errors.push(`Row ${rowNum}: title is required — row skipped`);          continue; }
        if (!dateRaw) { errors.push(`Row ${rowNum}: scheduled_date is required — row skipped`); continue; }

        // Parse date
        let scheduled_date = dateRaw;
        if (/^\d{5}$/.test(dateRaw)) {
          const jsDate = XLSX.SSF.parse_date_code(Number(dateRaw));
          scheduled_date = `${jsDate.y}-${String(jsDate.m).padStart(2, '0')}-${String(jsDate.d).padStart(2, '0')}`;
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
          errors.push(`Row ${rowNum}: scheduled_date must be YYYY-MM-DD (got: ${dateRaw}) — row skipped`);
          continue;
        }

        // ── Employee REQUIRED ─────────────────────────────────────────────
        if (!assigned_emp_id) {
          errors.push(`Row ${rowNum}: assigned_emp_id is required — row skipped`);
          continue;
        }
        const emp = await User.findOne({
          $or: [{ _id: assigned_emp_id }, { emp_id: assigned_emp_id }],
        }).select('_id manager_id').lean();
        if (!emp) {
          errors.push(`Row ${rowNum}: employee "${assigned_emp_id}" not found — row skipped`);
          continue;
        }
        const assigned_to = emp._id;

        // ── Manager REQUIRED ──────────────────────────────────────────────
        if (!manager_name_raw) {
          errors.push(`Row ${rowNum}: manager_name is required — row skipped`);
          continue;
        }
        const mgr = await User.findOne({
          name:      { $regex: new RegExp(`^${manager_name_raw}$`, 'i') },
          role:      'manager',
          is_active: 1,
        }).select('_id').lean();
        if (!mgr) {
          errors.push(`Row ${rowNum}: manager "${manager_name_raw}" not found — row skipped`);
          continue;
        }

        toInsert.push({
          _id:         uuidv4(),
          title,
          description,
          scheduled_date,
          location,
          assigned_to,
          manager_id:  mgr._id,
          created_by:  req.user.id,
        });
      }

      const inserted = toInsert.length ? await ActivitySchedule.insertMany(toInsert) : [];

      res.json({
        success:  true,
        inserted: inserted.length,
        skipped:  errors.length,
        errors,
        message:  `${inserted.length} schedule(s) created${errors.length ? `, ${errors.length} row(s) skipped` : ''}`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to parse file: ' + err.message });
    }
  }
);
// ── PUT /activity-schedule/:id/initiate ──────────────────────────────────
router.put('/:id/initiate', authenticate, async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (schedule.status !== 'Pending')
      return res.status(409).json({ success: false, message: 'Schedule is already initiated or completed' });
    if (schedule.assigned_to && schedule.assigned_to !== req.user.id)
      return res.status(403).json({ success: false, message: 'This schedule is assigned to another employee' });

    schedule.status       = 'Initiated';
    schedule.initiated_by = req.user.id;
    schedule.initiated_at = new Date();
    await schedule.save();
    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /activity-schedule/:id/complete ──────────────────────────────────
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
  // Save attachments — file_path = Cloudinary URL
    if (req.files?.length) {
      await ScheduleDocument.insertMany(req.files.map(f => ({
        _id:         uuidv4(),
        schedule_id: schedule._id,
        file_path:   f.path,        // ← Cloudinary URL
        file_name:   f.originalname,
        file_type:   f.mimetype,
        public_id:   f.filename,    // ← Cloudinary public_id (for deletion)
      })));
    }

    const documents = await ScheduleDocument.find({ schedule_id: schedule._id }).lean();
    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id, documents } });
  } catch (err) {
    console.error('PUT /complete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /activity-schedule/:id ────────────────────────────────────────
router.delete('/:id', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    const docs = await ScheduleDocument.find({ schedule_id: req.params.id }).lean();
   // Delete files from Cloudinary
    await Promise.all(docs.map(d => deleteFromCloudinary(d.public_id || d.file_path)));
    await ScheduleDocument.deleteMany({ schedule_id: req.params.id });
    await schedule.deleteOne();
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;