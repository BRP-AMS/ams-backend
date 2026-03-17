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
    if (assigned_to) {
      filter.$or = [
        { assigned_to: assigned_to },
        { initiated_by: assigned_to },
        { completed_by: assigned_to }
      ];
    }
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
      .select('_id name emp_id manager_id')
      .lean();

    // Map managers if needed
    const managerIds = new Set();
    users.forEach(u => { if (u.manager_id) managerIds.add(u.manager_id); });
    
    // Fetch managers who aren't already in users list
    const missingMgrIds = [...managerIds].filter(id => !userIds.has(id));
    if (missingMgrIds.length) {
      const extraMgrs = await User.find({ _id: { $in: missingMgrIds } }).select('_id name emp_id').lean();
      users.push(...extraMgrs);
    }

    const userMap = {};
    users.forEach(u => { 
      userMap[u._id] = { 
        name: u.name, 
        emp_id: u.emp_id,
        manager_id: u.manager_id
      }; 
    });

    // Second pass to attach manager_name to users
    users.forEach(u => {
      if (u.manager_id && userMap[u.manager_id]) {
        userMap[u._id].manager_name = userMap[u.manager_id].name;
      }
    });

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
      created_by_empid:  userMap[s.created_by]?.emp_id || null,
      assigned_to_name:  userMap[s.assigned_to]?.name  || null,
      assigned_to_empid: userMap[s.assigned_to]?.emp_id || null,
      manager_name:      userMap[s.assigned_to]?.manager_name || null,
      initiated_by_name: userMap[s.initiated_by]?.name || null,
      initiated_by_empid: userMap[s.initiated_by]?.emp_id || null,
      completed_by_name: userMap[s.completed_by]?.name || null,
      completed_by_empid: userMap[s.completed_by]?.emp_id || null,
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

    // Helper to find column case-insensitively
    const getVal = (row, keys) => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== '') return String(row[k]).trim();
        const lowerRow = Object.keys(row).reduce((acc, key) => { acc[key.toLowerCase()] = row[key]; return acc; }, {});
        for (const variant of keys) {
           const v = lowerRow[variant.toLowerCase()];
           if (v !== undefined && v !== '') return String(v).trim();
        }
      }
      return '';
    };

      let createdCount = 0;
      let updatedCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2; 

        try {
          const title = getVal(row, ['title', 'Title', 'Activity Name', 'Header', 'Activity', 'Subject', 'Name', 'Task', 'Work', 'Job']);
          const dateRaw = getVal(row, ['scheduled_date', 'Scheduled Date', 'date', 'Date', 'Day', 'Due Date', 'Target Date', 'Schedule']);
          const location = getVal(row, ['location', 'Location', 'Venue', 'Place', 'Address']) || null;
          const description = getVal(row, ['description', 'Description', 'Notes', 'Details', 'Work Description']) || null;
          const assigned_emp_id = getVal(row, ['assigned_emp_id', 'Assigned Emp ID', 'emp_id', 'Employee ID', 'Assign To', 'Staff ID', 'User ID', 'Assignee', 'Owner']);

          if (!title) { errors.push(`Row ${rowNum}: Title/Activity Name header not found or empty`); continue; }
          if (!dateRaw) { errors.push(`Row ${rowNum}: Date header not found or empty`); continue; }

          // Parse date - handles YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY and Excel serial dates
          let scheduled_date = String(dateRaw).trim().replace(/[/\s]/g, '-'); // normalize delims
          
          if (/^\d{5}$/.test(dateRaw)) {
            const jsDate = XLSX.SSF.parse_date_code(Number(dateRaw));
            scheduled_date = `${jsDate.y}-${String(jsDate.m).padStart(2,'0')}-${String(jsDate.d).padStart(2,'0')}`;
          } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(scheduled_date)) {
            // Handle D-M-YYYY or DD-MM-YYYY
            const parts = scheduled_date.split('-');
            scheduled_date = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
          } else if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(scheduled_date)) {
            // Try to parse with standard Date if it failed manual regex
            const d = new Date(dateRaw);
            if (!isNaN(d.getTime())) {
              scheduled_date = d.toISOString().split('T')[0];
            } else {
              errors.push(`Row ${rowNum}: Invalid date "${dateRaw}" (use YYYY-MM-DD or DD-MM-YYYY)`);
              continue;
            }
          }

          let assigned_to = null;
          if (assigned_emp_id) {
            const cleanEmpId = String(assigned_emp_id).trim();
            const emp = await User.findOne({ emp_id: { $regex: new RegExp(`^${cleanEmpId}$`, 'i') } }).select('_id').lean();
            if (!emp) { 
              // Instead of skipping, we can log a warning in errors but still create the task if title/date are ok?
              // The user said "no rows skipped", so let's just leave it unassigned if the ID is wrong
              errors.push(`Row ${rowNum}: Employee ID "${assigned_emp_id}" not found - creating as unassigned activity`);
              assigned_to = null; 
            } else {
              assigned_to = emp._id;
            }
          }

          // Check if it already exists (same title and date)
          const existing = await ActivitySchedule.findOne({
            title: { $regex: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
            scheduled_date
          });

          if (existing) {
            await ActivitySchedule.findByIdAndUpdate(existing._id, {
              $set: {
                description,
                location,
                assigned_to,
                // maintain created_by and status unless it's necessary to change
              }
            });
            updatedCount++;
          } else {
            await ActivitySchedule.create({
              _id:            uuidv4(),
              title,
              description,
              scheduled_date,
              location,
              assigned_to,
              created_by:     req.user.id,
              status:         'Pending'
            });
            createdCount++;
          }
        } catch (rowErr) {
          console.error(`Bulk Row ${rowNum} Error:`, rowErr);
          errors.push(`Row ${rowNum}: Unexpected error - ${rowErr.message}`);
        }
      }

      res.json({
        success:  true,
        created:  createdCount,
        updated:  updatedCount,
        skipped:  errors.length,
        errors,
        message:  `Bulk upload complete: ${createdCount} created, ${updatedCount} updated, ${errors.length} skipped`,
      });
    } catch (err) {
      console.error('POST /activity-schedule/bulk error:', err);
      res.status(500).json({ success: false, message: 'Failed to parse file: ' + err.message });
    }
  }
);

// ── GET /activity-schedule/export — export to Excel ───────────────────────
router.get('/export', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { status, date_from, date_to, assigned_to, created_by } = req.query;
    const filter = {};

    if (status)      filter.status         = status;
    if (assigned_to) {
      filter.$or = [
        { assigned_to: assigned_to },
        { initiated_by: assigned_to },
        { completed_by: assigned_to }
      ];
    }
    if (created_by)  filter.created_by     = created_by;
    if (date_from || date_to) {
      filter.scheduled_date = {};
      if (date_from) filter.scheduled_date.$gte = date_from;
      if (date_to)   filter.scheduled_date.$lte = date_to;
    }

    const schedules = await ActivitySchedule.find(filter)
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    // Populate user names
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

    // Prepare data for Excel
    const data = schedules.map(s => ({
      'Title':            s.title,
      'Description':      s.description || '',
      'Status':           s.status,
      'Scheduled Date':   s.scheduled_date,
      'Location':         s.location || '',
      'Assigned To':      userMap[s.assigned_to]?.name || '',
      'Assigned Emp ID':  userMap[s.assigned_to]?.emp_id || '',
      'Created By':       userMap[s.created_by]?.name || '',
      'Initiated By':     userMap[s.initiated_by]?.name || '',
      'Initiated At':     s.initiated_at ? new Date(s.initiated_at).toLocaleString() : '',
      'Completed By':     userMap[s.completed_by]?.name || '',
      'Completed At':     s.completed_at ? new Date(s.completed_at).toLocaleString() : '',
      'Work Description': s.work_description || '',
      'Remarks':          s.remarks || '',
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Activity Reports');

    // Auto-size columns
    const colWidths = [
      { wch: 25 }, { wch: 30 }, { wch: 12 }, { wch: 15 }, { wch: 20 },
      { wch: 20 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 22 },
      { wch: 20 }, { wch: 22 }, { wch: 35 }, { wch: 20 }
    ];
    ws['!cols'] = colWidths;

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="activity_reports_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /activity-schedule/export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /activity-schedule/export-pdf — export to PDF ─────────────────────
router.get('/export-pdf', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { status, date_from, date_to, assigned_to, created_by } = req.query;
    const filter = {};

    if (status)      filter.status         = status;
    if (assigned_to) {
      filter.$or = [
        { assigned_to: assigned_to },
        { initiated_by: assigned_to },
        { completed_by: assigned_to }
      ];
    }
    if (created_by)  filter.created_by     = created_by;
    if (date_from || date_to) {
      filter.scheduled_date = {};
      if (date_from) filter.scheduled_date.$gte = date_from;
      if (date_to)   filter.scheduled_date.$lte = date_to;
    }

    const schedules = await ActivitySchedule.find(filter)
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    // Populate user names
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

    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Disposition', `attachment; filename="activity_reports_${Date.now()}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text('BRP — Activity Schedule Report', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Status Filter: ${status || 'All'} | Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    // Table settings
    const colWidths = [120, 80, 80, 80, 100, 120, 150];
    const headers = ['Title', 'Date', 'Status', 'Assigned To', 'Completed By', 'Completed At', 'Work Desc'];
    let x = 30;
    let y = doc.y;

    // Draw headers
    doc.fontSize(9).font('Helvetica-Bold');
    headers.forEach((h, i) => {
      doc.text(h, x, y, { width: colWidths[i], ellipsis: true });
      x += colWidths[i];
    });

    doc.moveTo(30, y + 15).lineTo(760, y + 15).stroke();
    y += 25;
    doc.font('Helvetica').fontSize(8);

    schedules.forEach(s => {
      if (y > 500) {
        doc.addPage({ layout: 'landscape', margin: 30 });
        y = 30;
        // Repeat headers on new page
        x = 30;
        doc.fontSize(9).font('Helvetica-Bold');
        headers.forEach((h, i) => {
          doc.text(h, x, y, { width: colWidths[i], ellipsis: true });
          x += colWidths[i];
        });
        doc.moveTo(30, y + 15).lineTo(760, y + 15).stroke();
        y += 25;
        doc.font('Helvetica').fontSize(8);
      }

      x = 30;
      const rowData = [
        s.title,
        s.scheduled_date,
        s.status,
        userMap[s.assigned_to]?.name || 'All',
        userMap[s.completed_by]?.name || '-',
        s.completed_at ? new Date(s.completed_at).toLocaleString() : '-',
        s.work_description || '-'
      ];

      rowData.forEach((v, i) => {
        doc.text(String(v), x, y, { width: colWidths[i] - 5, ellipsis: true });
        x += colWidths[i];
      });

      y += 20;
      doc.moveTo(30, y - 5).lineTo(760, y - 5).strokeColor('#f0f0f0').stroke();
    });

    doc.end();
  } catch (err) {
    console.error('GET /activity-schedule/export-pdf error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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
    const assignedTo = String(schedule.assigned_to || '').toLowerCase().trim();
    const currentUserId = String(req.user.id || '').toLowerCase().trim();
    const isActuallyUnassigned = assignedTo === '' || assignedTo === 'null' || assignedTo === 'undefined';

    if (!isActuallyUnassigned && assignedTo !== currentUserId) {
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

module.exports = router;
