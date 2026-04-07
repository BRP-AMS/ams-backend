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
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `sched_${req.user.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
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

// ── PDF REPORT ───────────────────────────────────────────────────────────
router.get("/report/pdf", authenticate, async (req, res) => {
  try {
    const { filter } = req.query;
    const query = {};

    if (filter === "monthly") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      query.scheduled_date = {
        $gte: start.toISOString().slice(0,10),
        $lte: end.toISOString().slice(0,10),
      };
    }

    const activities = await ActivitySchedule.find(query).lean();
    const doc = new PDFDocument({ margin: 30 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition","attachment; filename=activities.pdf");

    doc.pipe(res);
    doc.fontSize(18).text("Activity Report",{align:"center"});
    doc.moveDown();

    if (!activities.length) {
      doc.fontSize(12).text("No activities found");
    } else {
      activities.forEach((a,i)=>{
        doc.fontSize(12)
          .text(`${i+1}. ${a.title || "-"}`)
          .text(`Location: ${a.location || "-"}`)
          .text(`Date: ${a.scheduled_date || "-"}`)
          .text(`Status: ${a.status || "-"}`)
          .moveDown();
      });
    }

    doc.end();
  } catch(err){
    console.error("PDF export error:",err);
    res.status(500).json({success:false,message:"PDF export failed"});
  }
});

// ── Bulk upload config ───────────────────────────────────────────────────
const bulkStorage = multer.memoryStorage();
const uploadBulk = multer({
  storage: bulkStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter:(req,file,cb)=>{
    const allowed=/xlsx|xls|csv/;
    if(allowed.test(path.extname(file.originalname).toLowerCase())) cb(null,true);
    else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
  }
});

// ── LIST schedules ───────────────────────────────────────────────────────
router.get('/', authenticate, async (req,res)=>{
  try{
    const schedules = await ActivitySchedule.find()
      .sort({scheduled_date:1, created_at:-1})
      .lean();

    res.json({success:true,data:schedules});
  }catch(err){
    console.error(err);
    res.status(500).json({success:false,message:'Server error'});
  }
});

// ── CREATE schedule ──────────────────────────────────────────────────────
router.post('/', authenticate, async (req,res)=>{
  try{
    const {title,description,scheduled_date,location,assigned_emp_id}=req.body;

    let employee_name=null;
    let manager_name=req.user.name;
    let assigned_to=null;

    if(assigned_emp_id){
      const emp=await User.findOne({emp_id:assigned_emp_id}).lean();
      if(emp){
        assigned_to=emp._id;
        employee_name=emp.name;
      }
    }

    const schedule=await ActivitySchedule.create({
      _id:uuidv4(),
      title,
      description,
      scheduled_date,
      location,
      assigned_to,
      employee_name,
      manager_name,
      assigned_by:req.user.name,
      created_by:req.user.id
    });

    res.status(201).json({success:true,data:schedule});

  }catch(err){
    res.status(500).json({message:err.message});
  }
});

// ── BULK UPLOAD ──────────────────────────────────────────────────────────
router.post('/bulk',
  authenticate,
  authorize('manager','admin','hr','super_admin'),
  uploadBulk.single('file'),
  async (req,res)=>{

  if(!req.file)
    return res.status(400).json({success:false,message:'No file uploaded'});

  try{

    const workbook = XLSX.read(req.file.buffer,{type:'buffer'});
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet,{defval:''});

    if(!rows.length)
      return res.status(422).json({success:false,message:'Excel file is empty'});

    const errors=[];
    const toInsert=[];

    for(let i=0;i<rows.length;i++){

      const row=rows[i];
      const rowNum=i+2;

      const title = String(row['title'] || '').trim();
      const dateRaw = String(row['scheduled_date'] || '').trim();
      const location = String(row['location'] || '').trim() || null;
      const description = String(row['description'] || '').trim() || null;
      const assigned_emp_id = String(row['assigned_emp_id'] || '').trim() || null;

      if(!title){ errors.push(`Row ${rowNum}: title required`); continue; }
      if(!dateRaw){ errors.push(`Row ${rowNum}: scheduled_date required`); continue; }

      let scheduled_date=dateRaw;

      if(!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)){
        errors.push(`Row ${rowNum}: date must be YYYY-MM-DD`);
        continue;
      }

      let assigned_to=null;
      let employee_name=null;

      if(assigned_emp_id){
        const emp=await User.findOne({emp_id:assigned_emp_id}).lean();
        if(!emp){
          errors.push(`Row ${rowNum}: employee not found`);
          continue;
        }
        assigned_to=emp._id;
        employee_name=emp.name;
      }

      toInsert.push({
        _id:uuidv4(),
        title,
        description,
        scheduled_date,
        location,
        assigned_to,
        employee_name,
        manager_name:req.user.name,
        assigned_by:req.user.name,
        created_by:req.user.id
      });

    } // ← FIX: loop properly closed

    let inserted=[];
    if(toInsert.length){
      inserted = await ActivitySchedule.insertMany(toInsert);
    }

    res.json({
      success:true,
      inserted:inserted.length,
      skipped:errors.length,
      errors,
      message:`${inserted.length} schedule(s) created`
    });

  }catch(err){
    console.error(err);
    res.status(500).json({success:false,message:'Failed to parse file: '+err.message});
  }
});

// ── COMPLETE schedule ────────────────────────────────────────────────────
router.put('/:id/complete',
  authenticate,
  uploadAttach.array('attachments',10),
  async(req,res)=>{
  try{

    const schedule=await ActivitySchedule.findById(req.params.id);
    if(!schedule)
      return res.status(404).json({success:false,message:'Schedule not found'});

    const {work_description,remarks}=req.body;

    schedule.status='Completed';
    schedule.completed_by=req.user.id;
    schedule.completed_at=new Date();
    schedule.work_description=work_description;
    schedule.remarks=remarks||null;

    await schedule.save();

    if(req.files?.length){
      const docs=req.files.map(f=>({
        _id:uuidv4(),
        schedule_id:schedule._id,
        file_path:`schedule/${f.filename}`,
        file_name:f.originalname,
        file_type:f.mimetype
      }));
      await ScheduleDocument.insertMany(docs);
    }

    const documents=await ScheduleDocument.find({schedule_id:schedule._id}).lean();

    res.json({
      success:true,
      data:{...schedule.toObject(),id:schedule._id,documents}
    });

  }catch(err){
    console.error(err);
    res.status(500).json({success:false,message:'Server error'});
  }
});

// ── DELETE schedule ──────────────────────────────────────────────────────
router.delete('/:id',
  authenticate,
  authorize('manager','admin','hr','super_admin'),
  async(req,res)=>{
  try{

    const schedule=await ActivitySchedule.findById(req.params.id);
    if(!schedule)
      return res.status(404).json({success:false,message:'Schedule not found'});

    await schedule.deleteOne();
    await ScheduleDocument.deleteMany({schedule_id:req.params.id});

    res.json({success:true,message:'Schedule deleted'});

  }catch(err){
    res.status(500).json({success:false,message:'Server error'});
  }
});

module.exports = router;