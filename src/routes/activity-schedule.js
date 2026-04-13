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
const uploadAttach = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// For bulk Excel/CSV upload
const uploadBulk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = /xlsx|xls|csv/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
  },
});

// ── GET /activity-schedule ────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, date_from, date_to, assigned_to, created_by } = req.query;
    const filter = {};
    if (status)      filter.status      = status;
    if (assigned_to) filter.assigned_to = assigned_to;
    // Employee: only see schedules assigned to them
if (req.user.role === 'employee') {
  filter.assigned_to = req.user.id;
}
    if (created_by)  filter.created_by  = created_by;
    if (date_from || date_to) {
      filter.scheduled_date = {};
      if (date_from) filter.scheduled_date.$gte = date_from;
      if (date_to)   filter.scheduled_date.$lte = date_to;
    }

    const schedules = await ActivitySchedule.find(filter)
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    const userIds = new Set();
    schedules.forEach(s => {
      ['created_by','assigned_to','assigned_by','manager_id','initiated_by','completed_by']
        .forEach(k => s[k] && userIds.add(s[k]));
    });

    const users = await User.find({ _id: { $in: [...userIds] } }).select('_id name emp_id role').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id] = { name: u.name, emp_id: u.emp_id, role: u.role }; });

    const completedIds = schedules.filter(s => s.status === 'Completed').map(s => s._id);
    const docs = completedIds.length ? await ScheduleDocument.find({ schedule_id: { $in: completedIds } }).lean() : [];
    const docsMap = {};
    docs.forEach(d => { if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = []; docsMap[d.schedule_id].push(d); });

    const rl = r => ({ employee:'Employee', manager:'Manager', admin:'Admin', hr:'HR', super_admin:'Super Admin' }[r] || '');

    const result = schedules.map(s => {
      const assignerUser = userMap[s.assigned_by] || userMap[s.created_by];
      return {
        ...s,
        id:                s._id,
        created_by_name:   userMap[s.created_by]?.name   || null,
        assigned_to_name:  userMap[s.assigned_to]?.name  || null,
        assigned_to_empid: userMap[s.assigned_to]?.emp_id || null,
        assigned_by_name:  s.assigned_by_name || (assignerUser ? `${assignerUser.name} (${rl(assignerUser.role)})` : null),
        assigned_by_empid: assignerUser?.emp_id || null,
        manager_name:      userMap[s.manager_id]?.name   || null,
        manager_empid:     userMap[s.manager_id]?.emp_id  || null,
        initiated_by_name: userMap[s.initiated_by]?.name || null,
        completed_by_name: userMap[s.completed_by]?.name || null,
        documents:         docsMap[s._id] || [],
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /activity-schedule error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /activity-schedule/my-completed ───────────────────────────────────────
router.get('/my-completed', authenticate, async (req, res) => {
  try {
    const schedules = await ActivitySchedule.find({ completed_by: req.user.id }).sort({ completed_at: -1 }).lean();
    const ids  = schedules.map(s => s._id);
    const docs = ids.length ? await ScheduleDocument.find({ schedule_id: { $in: ids } }).lean() : [];
    const docsMap = {};
    docs.forEach(d => { if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = []; docsMap[d.schedule_id].push(d); });
    res.json({ success: true, data: schedules.map(s => ({ ...s, id: s._id, documents: docsMap[s._id] || [] })) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /activity-schedule — create single ────────────────────────────────────
router.post('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { title, description, scheduled_date, location, assigned_emp_id, assigned_to: assignedToId, manager_id } = req.body;
    if (!title?.trim())  return res.status(422).json({ success: false, message: 'Title is required' });
    if (!scheduled_date) return res.status(422).json({ success: false, message: 'Scheduled date is required' });

    let assigned_to = null;
    if (assigned_emp_id) {
      const emp = await User.findOne({ emp_id: assigned_emp_id }).select('_id').lean();
      if (!emp) return res.status(404).json({ success: false, message: `Employee ${assigned_emp_id} not found` });
      assigned_to = emp._id;
    } else if (assignedToId) {
      const emp = await User.findById(assignedToId).select('_id').lean();
      if (!emp) return res.status(404).json({ success: false, message: 'Assigned employee not found' });
      assigned_to = emp._id;
    }

    const creator = await User.findById(req.user.id).select('name role emp_id').lean();
    const rl = r => ({ employee:'Employee', manager:'Manager', admin:'Admin', hr:'HR', super_admin:'Super Admin' }[r] || '');
    const assignedByName = creator ? `${creator.name} (${rl(creator.role)})` : null;

    // Resolve manager_id: admin/super_admin pass it explicitly; manager uses own id
    let resolvedManagerId = manager_id || null;
    if (!resolvedManagerId && creator?.role === 'manager') {
      resolvedManagerId = req.user.id;
    }

    const schedule = await ActivitySchedule.create({
      _id:              uuidv4(),
      title:            title.trim(),
      description:      description?.trim() || null,
      scheduled_date,
      location:         location?.trim() || null,
      assigned_to,
      created_by:       req.user.id,
      assigned_by:      req.user.id,
      assigned_by_name: assignedByName,
      manager_id:       resolvedManagerId,
    });

    res.status(201).json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    console.error('POST /activity-schedule error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /activity-schedule/bulk ───────────────────────────────────────────────
// Handles TWO template formats:
//   Manager template:    title | description | scheduled_date | location | assigned_emp_id
//   Admin template:      title | description | scheduled_date | location | manager_emp_id | assigned_emp_id
router.post('/bulk', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'),
  uploadBulk.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (!rows.length) return res.status(422).json({ success: false, message: 'Excel file is empty' });

      // Determine if uploader is manager
      const creator = await User.findById(req.user.id).select('name role emp_id').lean();
      const rl = r => ({ employee:'Employee', manager:'Manager', admin:'Admin', hr:'HR', super_admin:'Super Admin' }[r] || '');
      const assignedByName = creator ? `${creator.name} (${rl(creator.role)})` : null;
      const isManagerUploader = creator?.role === 'manager';

      const errors   = [];
      const toInsert = [];

      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2;

        const title           = String(row['title']          || row['Title']          || '').trim();
        const dateRaw         = String(row['scheduled_date'] || row['Scheduled Date'] || row['date'] || '').trim();
        const location        = String(row['location']       || row['Location']       || '').trim() || null;
        const description     = String(row['description']    || row['Description']    || '').trim() || null;
        const assigned_emp_id = String(row['assigned_emp_id'] || row['Assigned Emp ID'] || row['emp_id'] || '').trim() || null;
        // Admin template: manager_emp_id column -> resolve to manager_id in DB
        const manager_emp_id  = String(row['manager_emp_id'] || row['Manager Emp ID'] || '').trim() || null;
        // manager_name (manager template) and assigned_by (admin template) are informational display columns
        // backend always derives these from req.user and DB lookups, so they are intentionally ignored here

        if (!title)   { errors.push(`Row ${rowNum}: title is required`);          continue; }
        if (!dateRaw) { errors.push(`Row ${rowNum}: scheduled_date is required`); continue; }

        // Parse date
        let scheduled_date = dateRaw;
        if (/^\d{5}$/.test(dateRaw)) {
          const jsDate = XLSX.SSF.parse_date_code(Number(dateRaw));
          scheduled_date = `${jsDate.y}-${String(jsDate.m).padStart(2,'0')}-${String(jsDate.d).padStart(2,'0')}`;
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
          errors.push(`Row ${rowNum}: scheduled_date must be YYYY-MM-DD (got: ${dateRaw})`);
          continue;
        }

        // Resolve assigned_to
        let assigned_to = null;
        if (assigned_emp_id) {
          const emp = await User.findOne({ emp_id: assigned_emp_id }).select('_id').lean();
          if (!emp) { errors.push(`Row ${rowNum}: employee "${assigned_emp_id}" not found`); continue; }
          assigned_to = emp._id;
        }

        // Resolve manager_id:
        // - Manager uploading → always use own id
        // - Admin uploading with manager_emp_id column → look up that manager
        let resolvedManagerId = isManagerUploader ? req.user.id : null;
        if (!isManagerUploader && manager_emp_id) {
          const mgr = await User.findOne({ emp_id: manager_emp_id, role: 'manager' }).select('_id').lean();
          if (!mgr) { errors.push(`Row ${rowNum}: manager "${manager_emp_id}" not found`); continue; }
          resolvedManagerId = mgr._id;
        }

        toInsert.push({
          _id:              uuidv4(),
          title,
          description,
          scheduled_date,
          location,
          assigned_to,
          created_by:       req.user.id,
          assigned_by:      req.user.id,
          assigned_by_name: assignedByName,
          manager_id:       resolvedManagerId,
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
      console.error('POST /activity-schedule/bulk error:', err);
      res.status(500).json({ success: false, message: 'Failed to parse file: ' + err.message });
    }
  }
);

// ── GET /activity-schedule/template ───────────────────────────────────────────
// Returns the manager template (5 cols). Admin template is generated client-side.
router.get('/template', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['title', 'description', 'scheduled_date', 'location', 'assigned_emp_id'],
    ['Block Visit - Agartala', 'Awareness camp for MSMEs', '2025-06-10', 'Agartala', 'EMP001'],
    ['Training Workshop',      'Loan facilitation training', '2025-06-15', 'Udaipur',  'EMP002'],
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedules');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="schedule_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── PUT /activity-schedule/:id/initiate ──────────────────────────────────────
router.put('/:id/initiate', authenticate, async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (schedule.status !== 'Pending')
      return res.status(409).json({ success: false, message: 'Schedule is already initiated or completed' });
    if (schedule.assigned_to && schedule.assigned_to.toString() !== req.user.id)
      return res.status(403).json({ success: false, message: 'This schedule is assigned to another employee' });

    schedule.status       = 'Initiated';
    schedule.initiated_by = req.user.id;
    schedule.initiated_at = new Date();
    await schedule.save();
    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /activity-schedule/:id/complete ──────────────────────────────────────
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

    if (req.files?.length) {
      const urls = await Promise.all(req.files.map(f => uploadFile(f.buffer, 'ams/schedule-docs', f.originalname, f.mimetype)));
      await ScheduleDocument.insertMany(urls.map((url, i) => ({
        _id: uuidv4(), schedule_id: schedule._id,
        file_path: url, file_name: req.files[i].originalname, file_type: req.files[i].mimetype,
      })));
    }

    const documents = await ScheduleDocument.find({ schedule_id: schedule._id }).lean();
    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id, documents } });
  } catch (err) {
    console.error('PUT /complete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /activity-schedule/:id ────────────────────────────────────────────
router.delete('/:id', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    await ScheduleDocument.deleteMany({ schedule_id: req.params.id });
    await schedule.deleteOne();
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;