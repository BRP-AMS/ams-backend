/**
 * src/routes/reports.js
 *
 * P/OD logic (location-based, per employee assignment):
 *   - Employee has NO assigned_block/assigned_district → always P (default)
 *   - Employee HAS assignment:
 *       check-in location matches assigned_block or assigned_district → P
 *       check-in location is in ANY Tripura block/district (but not assigned) → OD
 *       check-in location is outside ALL known blocks/districts → '' (blank)
 *
 * Cell codes:
 *   P   = Present at assigned location       → no colour
 *   OD  = On Duty at other Tripura location  → no colour
 *   L   = Leave (approved) OR rejected leave with no re-check-in → RED
 *   A   = Absent (no check-in, after join)   → RED
 *   WO  = Weekend                            → light blue
 *   ""  = Blank (future / pre-join / outside all known locations / leave pending)
 *
 * Leave status logic:
 *   leave_status === 'Pending'  → blank  (not yet decided)
 *   leave_status === 'Approved' → L
 *   leave_status === 'Rejected' + no re-check-in → L  (LOP)
 *   leave_status === 'Rejected' + re-checked in  → P / OD (normal attendance)
 *
 * endDate always capped to yesterday for ATTENDANCE exports (today is incomplete)
 * Leave exports: NO cap — leaves are complete records
 * Signature row: Employee Sign (left) + Manager Sign (right) — side by side
 *
 * Override mutex:
 *   After manager acts, EITHER hr OR super_admin can override (first-wins).
 *   Once one party overrides, the other sees the remark but cannot override again.
 */
'use strict';

const express  = require('express');
const router   = express.Router();
const ExcelJS  = require('exceljs');
const PDFDoc   = require('pdfkit');
const mongoose = require('mongoose');
const { AttendanceRecord, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// ── Tripura blocks & districts ────────────────────────────────────────────────
const TRIPURA_BLOCKS = [
  'Agartala','Amarpur','Ambassa','Bagafa','Belonia','Bishalgarh','Boxanagar',
  'Dhalai','Dharmanagar','Gandacherra','Jampui Hills','Jolaibari','Jirania',
  'Kakraban','Kamalpur','Kanchanpur','Karbook','Khowai','Lefunga',
  'Longtarai Valley','Majlishpur','Matarbari','Melaghar','Mohanpur',
  'Mungiakami','Murasingh','Nasingh Para','Padmabil','Panisagar',
  'Ramchandraghat','Rupaichari','Sabroom','Salema','Sonamura','Surma','Teliamura',
];
const TRIPURA_DISTRICTS = [
  'Dhalai','Gomati','Khowai','North Tripura','Sipahijala',
  'South Tripura','Unakoti','West Tripura',
];
const ALL_TRIPURA = [...TRIPURA_BLOCKS, ...TRIPURA_DISTRICTS, 'Tripura'];

const isInTripura = addr => {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return ALL_TRIPURA.some(loc => a.includes(loc.toLowerCase()));
};

const matchesLocation = (addr, locationName) => {
  if (!addr || !locationName) return false;
  return addr.toLowerCase().includes(locationName.toLowerCase());
};

// ── IST helpers ───────────────────────────────────────────────────────────────
const IST      = 'Asia/Kolkata';
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });
const toObjId  = id => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return id; } };
const yesterdayIST = () => {
  const d = new Date(); d.setDate(d.getDate()-1);
  return d.toLocaleDateString('en-CA', { timeZone: IST });
};

const fmtDDMMYYYY = iso => iso ? iso.split('-').reverse().join('-') : '';

const expandDates = (start, end) => {
  const out = [];
  let cur = new Date(start+'T00:00:00+05:30');
  const fin = new Date(end +'T00:00:00+05:30');
  while (cur <= fin) {
    out.push(cur.toLocaleDateString('en-CA', { timeZone: IST }));
    cur.setDate(cur.getDate()+1);
  }
  return out;
};

const HOLIDAYS_MMDD = new Set([
  '01-14','01-23','01-26','03-04','03-21','04-03','04-14','04-15','04-21',
  '05-01','05-26','05-27','06-26','07-22','08-04','08-15','08-19','08-26',
  '09-04','10-02','10-17','10-19','10-20','10-21','10-22','10-23','10-26',
  '11-09','12-25',
]);
const RESTRICTED_MMDD = new Set([
  '01-01','03-03','03-25','03-31','06-20','07-16','08-12','08-28',
  '09-11','09-18','11-11','11-24','12-03','12-24',
]);

const isHoliday = iso => {
  const mmdd = iso.substring(5);
  return HOLIDAYS_MMDD.has(mmdd) || RESTRICTED_MMDD.has(mmdd);
};

const getNthSaturday = iso => {
  const d = new Date(iso + 'T00:00:00+05:30');
  if (d.getDay() !== 6) return 0;
  let count = 0;
  for (let i = 1; i <= d.getDate(); i++) {
    if (new Date(d.getFullYear(), d.getMonth(), i).getDay() === 6) count++;
  }
  return count;
};

const isNonWorkingDay = iso => {
  const dow = new Date(iso + 'T00:00:00+05:30').getDay();
  if (dow === 0) return true;                          // Sunday
  if (dow === 6) return true;
  return false;
};

const isWeekend = iso => isNonWorkingDay(iso); // kept for PDF total WO count
const dayNum    = iso => new Date(iso+'T00:00:00+05:30').getDate();
const monAbbr   = iso => new Date(iso+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,month:'short'});
const dayAbbr   = iso => new Date(iso+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,weekday:'short'});
const ordinal   = n   => { const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };
const colLetter = n   => { let s='',c=n; while(c>0){s=String.fromCharCode(65+(c-1)%26)+s;c=Math.floor((c-1)/26);} return s; };

/**
 * toCode — determines cell code for one attendance record
 */
// ── reports.js  ·  toCode() ───────────────────────────────────────────────
const toCode = (rec, assignedBlock, assignedDistrict) => {
  if (!rec) return 'A';

  // ── Leave records ──────────────────────────────────────────────────────────
  const isLeave = rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim());
  if (isLeave) {
    const ls = rec.leave_status || rec.status || 'Pending';
    if (ls === 'Pending') return 'LA';
    if (ls === 'Approved') {
      const isHalfDay = String(rec.leave_type || '').toLowerCase().includes('half');
      const hasCheckin = rec.checkin_time || rec.checkinTime;
      if (!(isHalfDay && hasCheckin)) return 'L';
      // Half Day + has check-in → fall through to attendance logic below
    }
    if (ls === 'Rejected') {
      const hasCheckin = rec.checkin_time || rec.checkinTime;
      if (!hasCheckin) return 'A';
      // Has a real check-in after rejection → fall through
    }
  }

  // ── Regular attendance ─────────────────────────────────────────────────────
  if (rec.status === 'Rejected') return 'A';

  // duty_type drives P vs OD — location is only a fallback
  const dutyType = (rec.duty_type || '').trim();

  if (dutyType === 'On Duty') return 'OD';   // employee chose "On Duty (Field)"

  // dutyType === 'Office Duty' (or blank/unknown) → location-based check
  const addr = rec.location_address || rec.locationAddress || '';

  // No assignment → always P
  if (!assignedBlock && !assignedDistrict) return 'P';

  const matchesAssigned =
    (assignedBlock    && matchesLocation(addr, assignedBlock))   ||
    (assignedDistrict && matchesLocation(addr, assignedDistrict));

  if (matchesAssigned)   return 'P';    // at assigned workplace
  if (isInTripura(addr)) return 'OD';   // elsewhere in Tripura (location fallback)
  return '';                            // outside all known locations
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/export
//  Attendance matrix export (Excel / PDF)
//  Supports:  empId, managerId  query params for HR / super_admin filtered downloads
// ══════════════════════════════════════════════════════════════════════════════
router.get('/export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format='excel', status, empId, managerId } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate||!endDate)
      return res.status(400).json({success:false,message:'startDate and endDate are required'});

    // Allow full selected range — future dates render as WO/H or blank columns

    const dates      = expandDates(startDate, endDate);
    const multiMonth = new Date(startDate+'T00:00:00+05:30').getMonth() !==
                       new Date(endDate  +'T00:00:00+05:30').getMonth();
    const totalDays  = dates.length;
 const woCount    = dates.filter(isNonWorkingDay).length;
    const holCount   = dates.filter(d => !isNonWorkingDay(d) && isHoliday(d)).length;
    // ── Employee list ──────────────────────────────────────────────────────────
    // Priority: employee (own) → specific empId → managerId team → manager (own team) → all
    let employees = [];

    const EMP_SELECT = '_id name emp_id created_at assigned_block assigned_district role_type designation';

    if (role === 'employee') {
      // Always own record only
      const me = await User.findById(req.user.id)
        .select(EMP_SELECT).lean();
      if (me) employees = [me];

    } else if (empId && String(empId).trim() !== '') {
      // Specific employee selected in dropdown
      const specificQuery = role === 'manager'
        ? { _id: toObjId(empId), manager_id: toObjId(req.user.id) }
        : { _id: toObjId(empId) };
      const specific = await User.findOne(specificQuery)
        .select('_id name emp_id created_at assigned_block assigned_district role_type').lean();
      if (specific) employees = [specific];
      else return res.status(404).json({success:false,message:'Selected employee not found'});

    } else if (managerId && String(managerId).trim() !== '') {
      // Manager's entire team selected (HR / super_admin / admin use-case)
      employees = await User.find({ manager_id:toObjId(managerId), is_active:{$ne:false} })
        .select(EMP_SELECT).sort({emp_id:1}).lean();

    } else if (role === 'manager') {
      // Manager viewing own team
      employees = await User.find({ manager_id:toObjId(req.user.id), is_active:{$ne:false} })
        .select(EMP_SELECT).sort({emp_id:1}).lean();

    } else {
      // admin / hr / super_admin — all employees
      employees = await User.find({ role:'employee', is_active:{$ne:false} })
        .select(EMP_SELECT).sort({emp_id:1}).lean();
    }

    if (!employees.length)
      return res.status(404).json({success:false,message:'No employees found'});

    // ── Manager / Reporting Officer name for signature ──────────────────────────
    let managerName = '';
    if (role === 'manager') {
      const mgr = await User.findById(req.user.id).select('name').lean();
      managerName = mgr?.name || '';
    } else if (role === 'employee') {
      // FIX: employee's own download must show their Reporting Officer
      // (set on the employee's profile page), NOT the assigned BRP manager.
      const emp = await User.findById(req.user.id)
        .select('reporting_officer_name reporting_officer_designation').lean();
      managerName = emp?.reporting_officer_name
        ? (emp.reporting_officer_designation
            ? `${emp.reporting_officer_designation}. ${emp.reporting_officer_name}`
            : emp.reporting_officer_name)
        : '';
    } else if (managerId && String(managerId).trim() !== '') {
      // HR/super_admin filtered by a specific manager — show that manager's name
      const mgr = await User.findById(toObjId(managerId)).select('name').lean();
      managerName = mgr?.name || '';
    }
    // admin/hr/super_admin without manager filter → no single manager; leave blank

    // ── Attendance records ─────────────────────────────────────────────────────
    const recFilter = {
      date:   {$gte:startDate,$lte:endDate},
      emp_id: {$in:employees.map(e=>e._id)},
    };
    if (status && status !== 'All') recFilter.status = status;
    const rawRecs = await AttendanceRecord.find(recFilter).sort({date:1}).lean();

    // Build index — prefer real check-in records over rejected leave records for the same date
    const recIdx = {};
    for (const r of rawRecs) {
      const eid = String(r.emp_id);
      if (!recIdx[eid]) recIdx[eid] = {};
      const existing = recIdx[eid][r.date];
      const existingIsRejectedLeave =
        existing &&
        (existing.duty_type === 'Leave' || (existing.leave_type && String(existing.leave_type).trim())) &&
        (existing.leave_status === 'Rejected' || existing.status === 'Rejected');
      // Replace if no existing record, or if existing is a rejected leave (prefer real check-in)
      if (!existing || existingIsRejectedLeave) {
        recIdx[eid][r.date] = r;
      }
    }

    // ── Build cell matrix ──────────────────────────────────────────────────────
    const matrix = employees.map(emp => {
      const joinDate = emp.created_at
        ? new Date(emp.created_at).toLocaleDateString('en-CA', { timeZone: IST })
        : null;
      const ab = emp.assigned_block    || null;
      const ad = emp.assigned_district || null;

    return {
        emp,
        cells: dates.map(iso => {
          if (isNonWorkingDay(iso))           return 'WO'; // Sunday or 2nd/4th Sat
          if (joinDate && iso < joinDate)     return '';   // pre-join → blank
          if (isHoliday(iso))                 return 'H';  // public holiday
          const rec = recIdx[String(emp._id)]?.[iso];
          // Future dates: only show LA if leave applied, else blank
          if (iso > todayIST()) {
            if (!rec) return '';
            const isLeave = rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim());
            if (isLeave && (rec.leave_status || rec.status || 'Pending') === 'Pending') return 'LA';
            return '';
          }
          return toCode(rec, ab, ad);
        }),
      };
    });

    const sd = new Date(startDate+'T00:00:00+05:30');
    const ed = new Date(endDate  +'T00:00:00+05:30');
    const rangeTitle =
      `for the period ${ordinal(sd.getDate())} ` +
      `${sd.toLocaleDateString('en-IN',{timeZone:IST,month:'short'})}- ${sd.getFullYear()} To ` +
      `${ordinal(ed.getDate())} ${ed.toLocaleDateString('en-IN',{timeZone:IST,month:'long'})} ${ed.getFullYear()}`;

    // ══════════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════════
    if (format==='excel') {
      const wb = new ExcelJS.Workbook(); wb.creator='RAMP AMS';

      const FILL_RED  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFF4444'}};
      const FILL_WO   = {type:'pattern',pattern:'solid',fgColor:{argb:'FFBDD7EE'}};
      const FILL_WHT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFFFF'}};
      const FILL_ALT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF7F7F7'}};
      const FILL_SUBH = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE8EDF4'}};

   const FILL_HOL  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
      const FILL_AMB  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
      const codeFill = (code, rf) => {
        if (code==='L'||code==='A') return FILL_RED;
        if (code==='WO')            return FILL_WO;
        if (code==='H'||code==='LA') return FILL_AMB;
        return rf;
      };
      const codeFont = (code) => {
        if (code==='L'||code==='A') return {bold:true,size:8,color:{argb:'FFFFFFFF'},name:'Calibri'};
        if (code==='LA')            return {bold:true,size:7,color:{argb:'FFD97706'},name:'Calibri'};
        return {bold:true,size:8,name:'Calibri'};
      };

      const TH  = ()=>({style:'thin',  color:{argb:'FFCCCCCC'}});
      const MED = ()=>({style:'medium',color:{argb:'FF999999'}});
      const CBDR = {top:TH(),bottom:TH(),left:TH(),right:TH()};
      const mc  = (ws,r1,c1,r2,c2)=>ws.mergeCells({top:r1,left:c1,bottom:r2,right:c2});
      const outerBorder = (ws,r1,c1,r2,c2)=>{
        for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++)
          ws.getCell(r,c).border={
            top:   r===r1?MED():TH(), bottom:r===r2?MED():TH(),
            left:  c===c1?MED():TH(), right: c===c2?MED():TH(),
          };
      };

      const buildSheet = (ws, empList, sheetTitle, mgrName,hCount=0) => {
        const LAST = 4+dates.length;

        // ── Rows 1-3: header ──────────────────────────────────────────────────
        mc(ws,1,2,1,LAST);
        Object.assign(ws.getCell(1,2),{value:'Attendance details of RAMP',font:{bold:true,size:13,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(1).height=24;

        mc(ws,2,2,2,LAST);
        Object.assign(ws.getCell(2,2),{value:rangeTitle,font:{bold:true,size:11,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(2).height=18;

        const half=2+Math.floor(dates.length/2);
        mc(ws,3,2,3,half-1);
        Object.assign(ws.getCell(3,2),{value:'Location Name: Tripura',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        mc(ws,3,half,3,LAST);
        Object.assign(ws.getCell(3,half),{value:'',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        ws.getRow(3).height=16;

        // ── Row 4: column headers ─────────────────────────────────────────────
        ws.getRow(4).height=multiMonth?38:26;
        ws.getColumn(2).width=9; ws.getColumn(3).width=16; ws.getColumn(4).width=14;
        const HF={bold:true,size:9,color:{argb:'FF3366FF'},name:'Calibri'};
        const setHdr=(col,val)=>{
          const c=ws.getCell(4,col); c.value=val; c.font=HF; c.fill=FILL_WHT; c.border=CBDR;
          c.alignment={horizontal:'center',vertical:'center',wrapText:col>4};
          ws.getColumn(col).width=col===2?9:col===3?16:col===4?14:4.2;
        };
        setHdr(2,'Emp code'); setHdr(3,'Employee Name'); setHdr(4,'Designation');
        dates.forEach((iso,i)=>setHdr(5+i,multiMonth?`${dayNum(iso)}\n${dayAbbr(iso)}\n${monAbbr(iso)}`:`${dayNum(iso)}\n${dayAbbr(iso)}`));

        // ── Data rows ─────────────────────────────────────────────────────────
        empList.forEach(({emp,cells},idx)=>{
          const rowN=5+idx; ws.getRow(rowN).height=15;
          const rf=idx%2===0?FILL_WHT:FILL_ALT;
          const c2=ws.getCell(rowN,2); c2.value=emp.emp_id; c2.border=CBDR; c2.fill=rf; c2.alignment={horizontal:'center',vertical:'center',wrapText:false}; c2.font={size:10,name:'Calibri'}; c2.protection={locked:true};
          const c3=ws.getCell(rowN,3); c3.value=emp.name;   c3.border=CBDR; c3.fill=rf; c3.alignment={horizontal:'left',  vertical:'center',wrapText:false}; c3.font={size:10,name:'Calibri'}; c3.protection={locked:true};
          const c4=ws.getCell(rowN,4); c4.value=emp.role_type||emp.designation||''; c4.border=CBDR; c4.fill=rf; c4.alignment={horizontal:'center',vertical:'center',wrapText:false}; c4.font={size:9,name:'Calibri'}; c4.protection={locked:true};
          cells.forEach((code,i)=>{
            const c=ws.getCell(rowN,5+i); c.value=code; c.border=CBDR;
            c.alignment={horizontal:'center',vertical:'center',wrapText:false};
            c.font={bold:!!code,size:code==='LA'?7:9,name:'Calibri',color:{argb:(code==='L'||code==='A')?'FFFFFFFF':code==='LA'?'FFD97706':'FF000000'}};
            c.fill=codeFill(code,rf); c.protection={locked:true};
          });
        });

        // ── Legend ────────────────────────────────────────────────────────────
        const legendRow=5+empList.length+1; ws.getRow(legendRow).height=14;
       const FILL_AMB = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
        [{code:'P',label:'Present (assigned location)',isRed:false},
         {code:'OD',label:'On Duty (other Tripura location)',isRed:false},
         {code:'H',label:'Public Holiday',isRed:false,isAmber:true},
         {code:'LA',label:'Leave Applied / Pending',isRed:false,isAmber:true},
         {code:'L',label:'Leave / LOP (Approved)',isRed:true},
         {code:'A',label:'Absent / Leave Rejected',isRed:true},
         {code:'WO',label:'Week Off',isRed:false},
        ].forEach(({code,label,isRed,isAmber},i)=>{
          const cc=ws.getCell(legendRow,5+i*2);
          cc.value=code; cc.fill=isRed?FILL_RED:isAmber?FILL_AMB:FILL_WHT; cc.border=CBDR;
          cc.alignment={horizontal:'center',vertical:'center'};
          cc.font={bold:true,size:8,name:'Calibri',color:{argb:isRed?'FFFFFFFF':isAmber?'FFD97706':'FF000000'}};
          ws.getCell(legendRow,5+i*2+1).value=label;
          ws.getCell(legendRow,5+i*2+1).font={size:8,name:'Calibri',italic:true};
        
        });

        // ── Summary ───────────────────────────────────────────────────────────
        const fDC=colLetter(5), lDC=colLetter(4+dates.length);
        let r=legendRow+2; const SR=r;
        ws.getColumn(2).width=28; ws.getColumn(3).width=12;
        const TF={bold:true,size:11,color:{argb:'FFC00000'},name:'Calibri'};
        const LF={bold:true,size:10,color:{argb:'FF1F3864'},name:'Calibri'};

        mc(ws,r,2,r,3);
        Object.assign(ws.getCell(r,2),{value:sheetTitle,fill:FILL_WHT,font:TF,alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(r).height=18;

        const sumRow=(label,value)=>{
          r++; ws.getRow(r).height=16;
          Object.assign(ws.getCell(r,2),{value:label,fill:FILL_WHT,font:LF,alignment:{horizontal:'left',vertical:'center'}});
          const vc=ws.getCell(r,3);
          const isF=typeof value==='string'&&value.startsWith('=');
          vc.value=isF?{formula:value.slice(1)}:value;
          vc.fill=FILL_WHT; vc.font=LF; vc.alignment={horizontal:'center',vertical:'center'}; vc.protection={locked:true};
        };

        sumRow('No of Total Days',totalDays);
        sumRow('No of Weekoff (WO)',woCount);
        sumRow('No of Holidays (H)',hCount);

        if(empList.length===1){
  const er=5;
  const empIdStr = String(empList[0].emp._id);

  // Pull this employee's leave-type records for the date range
  const empLeaveRecs = rawRecs.filter(r =>
    String(r.emp_id) === empIdStr &&
    (r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim()))
  );

  const byType = t => empLeaveRecs.filter(r => String(r.leave_type||'').toLowerCase().includes(t));
  const halfDayRecs   = byType('half');
  const emergencyRecs = byType('emergency');
  const casualRecs    = byType('casual');
  const pendingRecs   = empLeaveRecs.filter(r => (r.leave_status || r.status || 'Pending') === 'Pending');

  // Effective leave days: matches toCode()'s L logic, half-day counts as 0.5
  const effectiveLeaves = empLeaveRecs.reduce((sum, r) => {
    const ls = r.leave_status || r.status || 'Pending';
    if (ls === 'Pending') return sum;
    const isHalf = String(r.leave_type||'').toLowerCase().includes('half');
    const hasCheckin = r.checkin_time || r.checkinTime;
    if (ls === 'Approved') return (isHalf && hasCheckin) ? sum : sum + (isHalf ? 0.5 : 1);
    if (ls === 'Rejected') return hasCheckin ? sum : sum + (isHalf ? 0.5 : 1);
    return sum;
  }, 0);

  sumRow('No of Present / worked (P+OD)', `=COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")`);
  sumRow('No of Leaves (L)', `=COUNTIF(${fDC}${er}:${lDC}${er},"L")`);
  sumRow('No of Half Day Leaves (each = 0.5 day)', halfDayRecs.length);
  sumRow('No of Emergency Leaves', emergencyRecs.length);
  sumRow('No of Casual Leaves', casualRecs.length);
  sumRow('Total Effective Leaves', effectiveLeaves);
  sumRow('No of Absent (A)', `=COUNTIF(${fDC}${er}:${lDC}${er},"A")`);
  sumRow('No of Leave Applied / Pending (LA)', `=COUNTIF(${fDC}${er}:${lDC}${er},"LA")`);
}else {
          // ── Table header row ────────────────────────────────────────────────
          r++; ws.getRow(r).height = 17;
          ws.getColumn(2).width = 22; ws.getColumn(3).width = 16;
          ws.getColumn(4).width = 14; ws.getColumn(5).width = 14;

          [['Employee Name','FF1F3864'], ['Present / Worked','FF047857'], ['No of Leaves','FFB45309'], ['No of Absent','FFB91C1C']].forEach(([hdr, argb], i) => {
            const c = ws.getCell(r, 2 + i);
            c.value = hdr; c.fill = FILL_SUBH; c.border = CBDR;
            c.font = { bold: true, size: 10, color: { argb }, name: 'Calibri' };
            c.alignment = { horizontal: 'center', vertical: 'center' };
          });

          // ── One row per employee ────────────────────────────────────────────
          empList.forEach(({ emp }, idx) => {
            r++; ws.getRow(r).height = 15;
            const rf  = idx % 2 === 0 ? FILL_WHT : FILL_ALT;
            const er  = 5 + idx;

            const cn = ws.getCell(r, 2);
            cn.value = emp.name; cn.fill = rf; cn.border = CBDR;
            cn.font = { size: 10, name: 'Calibri' };
            cn.alignment = { horizontal: 'left', vertical: 'center' };

            const cp = ws.getCell(r, 3);
            cp.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")` };
            cp.fill = rf; cp.border = CBDR;
            cp.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF047857' } };
            cp.alignment = { horizontal: 'center', vertical: 'center' };
            cp.protection = { locked: true };

            const cl = ws.getCell(r, 4);
            cl.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"L")` };
            cl.fill = rf; cl.border = CBDR;
            cl.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFB45309' } };
            cl.alignment = { horizontal: 'center', vertical: 'center' };
            cl.protection = { locked: true };

            const ca = ws.getCell(r, 5);
            ca.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"A")` };
            ca.fill = rf; ca.border = CBDR;
            ca.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFB91C1C' } };
            ca.alignment = { horizontal: 'center', vertical: 'center' };
            ca.protection = { locked: true };
          });
        }

        outerBorder(ws, SR, 2, r, 5);

        // ── Signatures ────────────────────────────────────────────────────────
        r+=3; ws.getRow(r).height=20;

        if (role === 'employee') {
          // Employee download: Employee sign (left) + Manager sign (right)
          ws.getCell(r,2).value='Employee Sign:';
          ws.getCell(r,2).font={bold:true,size:10,name:'Calibri',color:{argb:'FF1F3864'}};
          mc(ws,r,3,r,6);
          const empSigCell=ws.getCell(r,3);
          empSigCell.value='';
          empSigCell.alignment={horizontal:'center',vertical:'bottom'};
          empSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};

          ws.getCell(r,8).value='Reporting Officer Sign:';
          ws.getCell(r,8).font={bold:true,size:15,name:'Calibri',color:{argb:'FF1F3864'}};
          mc(ws,r,12,r,13);
          const mgrSigCell=ws.getCell(r,12);
          mgrSigCell.value=mgrName?`(${mgrName})`:'';
          mgrSigCell.font={italic:true,size:10,name:'Calibri',color:{argb:'FF555555'}};
          mgrSigCell.alignment={horizontal:'center',vertical:'bottom'};
          mgrSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};
        }
        // Manager / HR / super_admin / admin: no signature row on exported sheet

        ws.views=[{state:'frozen',xSplit:4,ySplit:4}];
        ws.pageSetup={
          paperSize:9, orientation:'landscape',
          fitToPage:true, fitToWidth:1, fitToHeight:0,
          printTitlesRow:'$1:$4',
          margins:{left:0.2,right:0.2,top:0.4,bottom:0.4,header:0.2,footer:0.2},
        };
        ws.protect('BRP-READONLY',{
          selectLockedCells:true,selectUnlockedCells:true,
          formatCells:false,insertRows:false,insertColumns:false,
          deleteRows:false,deleteColumns:false,sort:false,
        });
      };

      if(role==='employee'){
        buildSheet(wb.addWorksheet('My Attendance'),matrix,`${matrix[0]?.emp.name} Summary`,managerName,holCount);
      } else {
        const allName =role==='manager'?'Team Report':'All emp Reports';
        const allTitle=role==='manager'?'Team Summary':'Total Summary';
        buildSheet(wb.addWorksheet(allName),matrix,allTitle,managerName,holCount);
        matrix.forEach(({emp,cells})=>{
          const name=emp.name.replace(/[:\\/?*[\]]/g,'').substring(0,31);
          buildSheet(wb.addWorksheet(name),[{emp,cells}],`${emp.name} Summary`,managerName,holCount);
        });
      }

      const fnamePrefix = matrix.length === 1
        ? `${(matrix[0].emp.name||'').replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'')}_${matrix[0].emp.emp_id||''}_`
        : '';
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${fnamePrefix}BRP_Attendance_${startDate}_to_${endDate}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════════
    if(format==='pdf'){
      const doc=new PDFDoc({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},autoFirstPage:true});
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="BRP_Attendance_${startDate}_to_${endDate}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const PW=doc.page.width,PH=doc.page.height,ML=28;
      const CC=52,CN=105,CD=64,CT=36;
      const dW=Math.max(11,(PW-56-CC-CN-CD-CT)/dates.length);
      const RH=14;
      const xC=ML,xN=ML+CC,xDes=xN+CN,xD=xDes+CD,xT=xD+dates.length*dW,tW=xT+CT-ML;

      const addPage=()=>doc.addPage({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28}});

     const drawHdr=y=>{
  doc.rect(ML,y,tW,20).fill('#FFF').stroke('#AAA');
  doc.fillColor('#000').fontSize(12).font('Helvetica-Bold').text('Attendance details of RAMP',ML,y+5,{width:tW,align:'center'});
  doc.rect(ML,y+20,tW,14).fill('#FFF').stroke('#AAA');
  doc.fillColor('#161515').fontSize(8).font('Helvetica').text(rangeTitle,ML,y+23,{width:tW,align:'center'});
  doc.rect(ML,y+34,tW,12).fill('#FFF').stroke('#AAA');
  doc.fillColor('#000').fontSize(7).font('Helvetica-Bold')
     .text('Location: Tripura',ML+4,y+37);

  const y2=y+46;
  const HRH = multiMonth ? 32 : 24;   // taller header row to fit day-num + weekday (+ month)

  [[xC,CC,'Emp code'],[xN,CN,'Employee Name'],[xDes,CD,'Designation']].forEach(([x,w,l])=>{
    doc.rect(x,y2,w,HRH).fill('#FFF').stroke('#AAA');
    doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold')
       .text(l,x+2,y2+(HRH-9)/2,{width:w-4,align:'center'});
  });

  dates.forEach((iso,i)=>{
    const x=xD+i*dW;
    doc.rect(x,y2,dW,HRH).fill('#FFF').stroke('#AAA');
    doc.fillColor('#3366FF').fontSize(6).font('Helvetica-Bold')
       .text(String(dayNum(iso)),x+1,y2+3,{width:dW-2,align:'center'});
    doc.fillColor('#555').fontSize(5).font('Helvetica')
       .text(dayAbbr(iso),x+1,y2+11,{width:dW-2,align:'center'});
    if (multiMonth) {
      doc.fillColor('#888').fontSize(5).font('Helvetica')
         .text(monAbbr(iso),x+1,y2+19,{width:dW-2,align:'center'});
    }
  });

  doc.rect(xT,y2,CT,HRH).fill('#FFF').stroke('#AAA');
  doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold')
     .text('Total',xT+2,y2+(HRH-9)/2,{width:CT-4,align:'center'});

  return y2+HRH;
};
      let y=drawHdr(ML);
      matrix.forEach(({emp,cells},idx)=>{
        if(y+RH>PH-60){addPage();y=drawHdr(28);}
        const bg=idx%2===0?'#F9F9F9':'#FFF';
        doc.rect(ML,y,tW,RH).fill(bg).stroke('#CCC');
        doc.fillColor('#000').fontSize(7).font('Helvetica').text(emp.emp_id||'',xC+2,y+3,{width:CC-4,align:'center'});
        doc.font('Helvetica-Bold').text(emp.name,xN+2,y+3,{width:CN-4});
        doc.font('Helvetica').fontSize(6.5).text(emp.role_type||emp.designation||'',xDes+2,y+4,{width:CD-4,align:'center',lineBreak:false,ellipsis:true});
        let pres=0;
        cells.forEach((code,i)=>{
          const x=xD+i*dW;
          const isRed=code==='L'||code==='A';
          const isAmb=code==='H'||code==='LA';
          const cellBg=isRed?'#FF4444':code==='WO'?'#BDD7EE':isAmb?'#FFF3CD':bg;
          doc.rect(x,y,dW,RH).fill(cellBg).stroke('#CCC');
          if(code){
            const fg=isRed?'#FFFFFF':isAmb?'#D97706':'#000000';
            const fs=code==='LA'?5:6;
            doc.fillColor(fg).fontSize(fs).font('Helvetica-Bold')
               .text(code,x+1,y+3,{width:dW-2,align:'center'});
          }
          if(code==='P'||code==='OD') pres++;
        });
        doc.rect(xT,y,CT,RH).fill('#FFF').stroke('#AAA');
        doc.fillColor('#000').fontSize(7).font('Helvetica-Bold').text(String(pres),xT+2,y+3,{width:CT-4,align:'center'});
        y+=RH;
      });

      // Legend
      y+=10; if(y+20>PH-80){addPage();y=40;}
      let lx=ML;
      [{code:'P',label:'Present (assigned location)',red:false},
       {code:'OD',label:'On Duty (other Tripura location)',red:false},
       {code:'LA',label:'Leave Applied / Pending',red:false,amber:true},
       {code:'L',label:'Leave / LOP (Approved)',red:true},
       {code:'A',label:'Absent / Leave Rejected',red:true},
       {code:'WO',label:'Week Off',red:false},
      ].forEach(({code,label,red,amber})=>{
        const bw=14,lw=86;
        const bg=red?'#FF4444':amber?'#FFF3CD':'#FFFFFF';
        const fg=red?'#FFFFFF':amber?'#D97706':'#000000';
        doc.rect(lx,y,bw,10).fill(bg).stroke('#999');
        doc.fillColor(fg).fontSize(6).font('Helvetica-Bold').text(code,lx+1,y+2,{width:bw-2,align:'center'});
        doc.fillColor('#333').fontSize(7).font('Helvetica').text(label,lx+bw+2,y+1,{width:lw});
        lx+=bw+lw+4;
      });
      y+=18;

      // Summary
      y+=4; if(y+130>PH-60){addPage();y=40;}
      const SW=240,SRH=16,SX=ML; let sy=y;
      const pdfRow=(label,value,type='row')=>{
        if(type==='title'){doc.rect(SX,sy,SW,SRH).fill('#FFF').stroke('#000'); doc.fillColor('#C00000').fontSize(10).font('Helvetica-Bold').text(label,SX,sy+3,{width:SW,align:'center'});}
        else if(type==='sub'){doc.rect(SX,sy,SW,SRH).fill('#E8EDF4').stroke('#000'); doc.fillColor('#1F3864').fontSize(9).font('Helvetica-Bold').text(label,SX,sy+3,{width:SW,align:'center'});}
        else{
          doc.rect(SX,sy,SW*0.72,SRH).fill('#FFF').stroke('#000');
          doc.rect(SX+SW*0.72,sy,SW*0.28,SRH).fill('#FFF').stroke('#000');
          doc.fillColor('#1F3864').fontSize(9).font('Helvetica-Bold').text(label,SX+4,sy+3,{width:SW*0.68});
          if(value!==undefined) doc.text(String(value),SX+SW*0.72,sy+3,{width:SW*0.26,align:'center'});
        }
        sy+=SRH;
      };
      const summaryTitle=role==='employee'?`${matrix[0]?.emp.name} Summary`:role==='manager'?'Team Summary':'Total Summary';
      pdfRow(summaryTitle,undefined,'title');
      pdfRow('No of Total Days',totalDays);
      pdfRow('No of Weekoff (WO)',woCount);
      pdfRow('No of Holidays (H)',holCount);

      if (matrix.length === 1) {
  const cells   = matrix[0].cells;
  const empIdStr = String(matrix[0].emp._id);

  const empLeaveRecs = rawRecs.filter(r =>
    String(r.emp_id) === empIdStr &&
    (r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim()))
  );
  const byType = t => empLeaveRecs.filter(r => String(r.leave_type||'').toLowerCase().includes(t));
  const halfDayRecs   = byType('half');
  const emergencyRecs = byType('emergency');
  const casualRecs    = byType('casual');
  const pendingRecs   = empLeaveRecs.filter(r => (r.leave_status || r.status || 'Pending') === 'Pending');
  const effectiveLeaves = empLeaveRecs.reduce((sum, r) => {
    const ls = r.leave_status || r.status || 'Pending';
    if (ls === 'Pending') return sum;
    const isHalf = String(r.leave_type||'').toLowerCase().includes('half');
    const hasCheckin = r.checkin_time || r.checkinTime;
    if (ls === 'Approved') return (isHalf && hasCheckin) ? sum : sum + (isHalf ? 0.5 : 1);
    if (ls === 'Rejected') return hasCheckin ? sum : sum + (isHalf ? 0.5 : 1);
    return sum;
  }, 0);

  pdfRow('No of Present / worked (P+OD)', cells.filter(c => c==='P'||c==='OD').length);
  pdfRow('No of Leaves (L)',               cells.filter(c => c==='L').length);
  pdfRow('No of Half Day Leaves (each = 0.5 day)', halfDayRecs.length);
  pdfRow('No of Emergency Leaves',                 emergencyRecs.length);
  pdfRow('No of Casual Leaves',                    casualRecs.length);
  pdfRow('Total Effective Leaves',                 effectiveLeaves);
  pdfRow('No of Absent (A)',               cells.filter(c => c==='A').length);
  pdfRow('No of Leave Applied / Pending (LA)',      cells.filter(c => c==='LA').length);
} else {
        sy++;
        const TW = SW;
        const C0 = TW * 0.46;
        const C1 = TW * 0.18;
        const C2 = TW * 0.18;
        const C3 = TW * 0.18;

        doc.rect(SX,        sy, C0, SRH).fill('#E8EDF4').stroke('#000');
        doc.rect(SX+C0,     sy, C1, SRH).fill('#D1FAE5').stroke('#000');
        doc.rect(SX+C0+C1,  sy, C2, SRH).fill('#FEF3C7').stroke('#000');
        doc.rect(SX+C0+C1+C2, sy, C3, SRH).fill('#FEE2E2').stroke('#000');

        doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold').text('Employee',   SX+4,    sy+4, {width:C0-8});
        doc.fillColor('#047857').fontSize(8).font('Helvetica-Bold').text('Present',    SX+C0,   sy+4, {width:C1,align:'center'});
        doc.fillColor('#B45309').fontSize(8).font('Helvetica-Bold').text('Leaves',     SX+C0+C1,sy+4, {width:C2,align:'center'});
        doc.fillColor('#B91C1C').fontSize(8).font('Helvetica-Bold').text('Absent',     SX+C0+C1+C2,sy+4,{width:C3,align:'center'});
        sy += SRH;

        matrix.forEach(({ emp, cells }, idx) => {
          const bg = idx % 2 === 0 ? '#FFFFFF' : '#F7F7F7';
          doc.rect(SX,          sy, C0, SRH).fill(bg).stroke('#CCCCCC');
          doc.rect(SX+C0,       sy, C1, SRH).fill(bg).stroke('#CCCCCC');
          doc.rect(SX+C0+C1,    sy, C2, SRH).fill(bg).stroke('#CCCCCC');
          doc.rect(SX+C0+C1+C2, sy, C3, SRH).fill(bg).stroke('#CCCCCC');

          const pres = cells.filter(c => c==='P'||c==='OD').length;
          const lv   = cells.filter(c => c==='L').length;
          const abs  = cells.filter(c => c==='A').length;

          doc.fillColor('#1F3864').fontSize(8.5).font('Helvetica-Bold').text(emp.name,     SX+4,   sy+3,{width:C0-8,lineBreak:false,ellipsis:true});
          doc.fillColor('#047857').fontSize(9  ).font('Helvetica-Bold').text(String(pres), SX+C0,  sy+3,{width:C1,align:'center'});
          doc.fillColor('#B45309').fontSize(9  ).font('Helvetica-Bold').text(String(lv),   SX+C0+C1,sy+3,{width:C2,align:'center'});
          doc.fillColor('#B91C1C').fontSize(9  ).font('Helvetica-Bold').text(String(abs),  SX+C0+C1+C2,sy+3,{width:C3,align:'center'});
          sy += SRH;
        });
      }

      // Signatures (employee download only)
      sy+=24; if(sy+30>PH-28){addPage();sy=40;}
      const sigLineW=140;
if (role === 'employee') {
  // Employee Sign
  doc.fillColor('#1F3864').fontSize(12).font('Helvetica-Bold').text('Employee Sign:', ML, sy);
  doc.moveTo(ML + 110, sy + 12).lineTo(ML + 110 + sigLineW, sy + 12).stroke('#999');

  // Reporting Officer block — CSS matched to reference layout
  const roX = ML + 110 + sigLineW + 80;
  doc.fillColor('#1F3864').fontSize(12).font('Helvetica-Bold').text('Reporting Officer:', roX, sy);

  const lineGap = 30;
  let ry = sy + lineGap;

  // Name/Designation — thin grey line, value (if known) sits above the line
  doc.fillColor('#3B6EA5').fontSize(9).font('Helvetica').text('Name/Designation:', roX, ry);
  if (managerName) {
    doc.fillColor('#333').fontSize(10).font('Helvetica-Oblique')
       .text(managerName, roX + 100, ry - 9, { width: sigLineW });
  }
  doc.moveTo(roX + 100, ry + 9).lineTo(roX + 100 + sigLineW, ry + 9).stroke('#999');

  ry += lineGap + 10;
  doc.fillColor('#3B6EA5').fontSize(9).font('Helvetica').text('Signature & Stamp:', roX, ry);
  doc.moveTo(roX + 100, ry + 9).lineTo(roX + 100 + sigLineW, ry + 9).stroke('#1F3864');

  ry += lineGap + 10;
  doc.fillColor('#3B6EA5').fontSize(9).font('Helvetica').text('Date:', roX, ry);
  doc.moveTo(roX + 100, ry + 9).lineTo(roX + 100 + sigLineW * 0.55, ry + 9).stroke('#999');
}

      doc.end();
      return;
    }

    res.status(400).json({success:false,message:'format must be excel or pdf'});
  } catch(err){
    console.error('[ReportsExport]',err);
    res.status(500).json({success:false,message:'Export failed',error:err.message});
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/leave-export
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leave-export',
  authenticate,
  authorize('super_admin', 'admin', 'hr', 'manager', 'employee'),
  async (req, res) => {
  try {
    const { format = 'excel', status, empId } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate)
      return res.status(400).json({ success: false, message: 'startDate and endDate are required' });

    // NO cap to yesterday for leave reports — leaves are complete records
    if (startDate > endDate)
      return res.status(400).json({ success: false, message: 'startDate must be before or equal to endDate' });

    // ── Employee scope ─────────────────────────────────────────────────────────
    let employees = [];

    if (role === 'employee') {
      const me = await User.findById(req.user.id).select('_id name emp_id').lean();
      if (me) employees = [me];

    } else if (empId && String(empId).trim() !== '') {
      const specificQuery2 = role === 'manager'
        ? { _id: toObjId(empId), manager_id: toObjId(req.user.id) }
        : { _id: toObjId(empId) };
      const specific = await User.findOne(specificQuery2).select('_id name emp_id').lean();
      if (specific) employees = [specific];
      else return res.status(404).json({ success: false, message: 'Selected employee not found' });

    } else if (role === 'manager') {
      employees = await User.find({ manager_id: toObjId(req.user.id), is_active: { $ne: false } })
        .select('_id name emp_id').sort({ emp_id: 1 }).lean();

    } else {
      employees = await User.find({ role: 'employee', is_active: { $ne: false } })
        .select('_id name emp_id').sort({ emp_id: 1 }).lean();
    }

    if (!employees.length)
      return res.status(404).json({ success: false, message: 'No employees found' });

    // ── Fetch records ──────────────────────────────────────────────────────────
    const allRecs = await AttendanceRecord.find({
      date:   { $gte: startDate, $lte: endDate },
      emp_id: { $in: employees.map(e => e._id) },
    }).sort({ date: 1 }).lean();

    const leaveRecs = allRecs.filter(r =>
      r.duty_type === 'Leave' ||
      (r.leave_type && String(r.leave_type).trim() !== '')
    );

    const filtered = (status && status !== 'All')
      ? leaveRecs.filter(r => r.leave_status === status)
      : leaveRecs;

    const empMap = {};
    for (const e of employees) empMap[String(e._id)] = e;
const rows = filtered.map(r => {
  const startD    = r.date || '';
  const endD      = r.end_date || startD;
  const dayCount  = (startD && endD && endD !== startD)
    ? Math.round((new Date(endD) - new Date(startD)) / 86400000) + 1
    : 1;
  return {
    empCode:       empMap[String(r.emp_id)]?.emp_id || '',
    empName:       empMap[String(r.emp_id)]?.name   || '',
    startDate:     fmtDDMMYYYY(startD),
    endDate:       endD !== startD ? fmtDDMMYYYY(endD) : '',
    days:          String(dayCount),
    leaveType:     r.leave_type     || '',
    status:        r.leave_status   || r.status || '',
    reason:        r.leave_reason   || '',
    managerRemark: r.manager_remark || '',
    hrOverride:    r.hr_override    ? 'Yes' : 'No',
    hrRemark:      r.hr_remark      || '',
  };
});

    const sd = new Date(startDate + 'T00:00:00+05:30');
    const ed = new Date(endDate   + 'T00:00:00+05:30');
    const rangeLabel =
      `${ordinal(sd.getDate())} ${sd.toLocaleDateString('en-IN', { timeZone: IST, month: 'short' })} ${sd.getFullYear()}` +
      ` To ` +
      `${ordinal(ed.getDate())} ${ed.toLocaleDateString('en-IN', { timeZone: IST, month: 'long' })} ${ed.getFullYear()}`;

    const reportTitle = employees.length === 1
      ? `Leave Report – ${employees[0].name} (${employees[0].emp_id || '—'})`
      : 'Leave Report – BRP (Block Resource Person)';

    const approved = rows.filter(r => r.status === 'Approved').length;
    const rejected = rows.filter(r => r.status === 'Rejected').length;
    const pending  = rows.filter(r => r.status === 'Pending').length;

    const singleEmp = employees.length === 1 ? employees[0] : null;
    const empPrefix = singleEmp
      ? `${(singleEmp.name || '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')}_${singleEmp.emp_id || ''}_`
      : '';

    // ══════════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════════
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook(); wb.creator = 'RAMP AMS';
      const ws = wb.addWorksheet('Leave Report');

      const FILL_HDR     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
      const FILL_SUB     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF4' } };
      const FILL_EVEN    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      const FILL_ODD     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
      const FILL_APPROVE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      const FILL_REJECT  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      const FILL_PENDING = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };
      const CBDR = {
        top:    { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left:   { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right:  { style: 'thin', color: { argb: 'FFCCCCCC' } },
      };
      const COLS = [
        { key: 'empCode',       header: 'Emp Code',      width: 12 },
        { key: 'empName',       header: 'Employee Name',  width: 22 },
         { key: 'startDate',     header: 'From Date',       width: 14 },
  { key: 'endDate',       header: 'To Date',         width: 14 },
   { key: 'days',          header: 'Days',            width:  7 },
        { key: 'leaveType',     header: 'Leave Type',     width: 18 },
        { key: 'status',        header: 'Status',         width: 14 },
        { key: 'reason',        header: 'Reason',         width: 32 },
        { key: 'managerRemark', header: 'Manager Remark', width: 28 },
        { key: 'hrOverride',    header: 'HR Override',    width: 13 },
        { key: 'hrRemark',      header: 'HR Remark',      width: 28 },
      ];
      const NC = COLS.length;

      ws.mergeCells(1, 1, 1, NC);
      Object.assign(ws.getCell(1, 1), {
        value: reportTitle,
        font:  { bold: true, size: 14, color: { argb: 'FFFFFFFF' }, name: 'Calibri' },
        fill:  FILL_HDR,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(1).height = 26;

      ws.mergeCells(2, 1, 2, NC);
      Object.assign(ws.getCell(2, 1), {
        value: `Period: ${rangeLabel}`,
        font:  { bold: true, size: 11, color: { argb: 'FF1F3864' }, name: 'Calibri' },
        fill:  FILL_SUB,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(2).height = 18;

      ws.mergeCells(3, 1, 3, NC);
      Object.assign(ws.getCell(3, 1), {
        value: `Total: ${rows.length}   |   Approved: ${approved}   |   Rejected: ${rejected}   |   Pending: ${pending}`,
        font:  { size: 10, italic: true, color: { argb: 'FF444444' }, name: 'Calibri' },
        fill:  FILL_SUB,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(3).height = 15;

      ws.getRow(4).height = 18;
      COLS.forEach((col, i) => {
        ws.getColumn(i + 1).width = col.width;
        const c = ws.getCell(4, i + 1);
        c.value = col.header;
        c.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
        c.fill  = FILL_HDR;
        c.border = CBDR;
        c.alignment = { horizontal: 'center', vertical: 'center' };
      });

      if (rows.length === 0) {
        ws.mergeCells(5, 1, 5, NC);
        Object.assign(ws.getCell(5, 1), {
          value: 'No leave records found for the selected period and filters.',
          font:  { italic: true, size: 10, color: { argb: 'FF888888' } },
          alignment: { horizontal: 'center', vertical: 'center' },
        });
        ws.getRow(5).height = 18;
      } else {
        rows.forEach((row, idx) => {
          const rowN = 5 + idx;
          ws.getRow(rowN).height = 15;
          let rowFill = idx % 2 === 0 ? FILL_EVEN : FILL_ODD;
          if      (row.status === 'Approved') rowFill = FILL_APPROVE;
          else if (row.status === 'Rejected') rowFill = FILL_REJECT;
          else if (row.status === 'Pending')  rowFill = FILL_PENDING;

          COLS.forEach((col, i) => {
            const c = ws.getCell(rowN, i + 1);
            c.value  = row[col.key] || '';
            c.fill   = rowFill;
            c.border = CBDR;
            c.font   = { size: 9, name: 'Calibri' };
            c.alignment = {
              horizontal: ['empCode','status','hrOverride','days','startDate','endDate'].includes(col.key) ? 'center' : 'left',
              vertical:   'center',
              wrapText:   ['reason','managerRemark','hrRemark'].includes(col.key),
            };
          });

          const sc = ws.getCell(rowN, 5);
          const statusColor =
            row.status === 'Approved' ? 'FF047857' :
            row.status === 'Rejected' ? 'FFB91C1C' : 'FFB45309';
          sc.font = { bold: true, size: 9, name: 'Calibri', color: { argb: statusColor } };
        });
      }

      ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 4 }];
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: NC } };
      ws.pageSetup = {
        paperSize: 9, orientation: 'portrait',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: '$1:$4',
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${empPrefix}Leave_Report_${startDate}_to_${endDate}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════════
    if (format === 'pdf') {
      const doc = new PDFDoc({
        size: 'A4', layout: 'landscape',
        margins: { top: 28, bottom: 28, left: 28, right: 28 },
        autoFirstPage: true,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${empPrefix}Leave_Report_${startDate}_to_${endDate}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const ML      = 28;
      const usableW = doc.page.width - ML * 2;
      const colWidths = [55, 150, 65, 65, 30, 85, 65, 130, 120, 50, 90];
      const colKeys   = ['empCode','empName','startDate','endDate','days','leaveType','status','reason','managerRemark','hrOverride','hrRemark'];
      const colHdrs   = ['Emp Code','Employee Name','From Date','To Date','Days','Leave Type','Status','Reason','Manager Remark','HR Override','HR Remark'];
      const totalW    = colWidths.reduce((a, b) => a + b, 0);
      const cw        = colWidths.map(w => (w / totalW) * usableW);
      const RH = 14, HRH = 16;
      let y = ML;

      const drawPageHeader = (yy) => {
        doc.rect(ML, yy, usableW, 20).fill('#1F3864');
        doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
           .text(reportTitle, ML, yy + 5, { width: usableW, align: 'center' });
        yy += 20;
        doc.rect(ML, yy, usableW, 13).fill('#E8EDF4').stroke('#CCCCCC');
        doc.fillColor('#1F3864').fontSize(8).font('Helvetica')
           .text(
             `Period: ${rangeLabel}   |   Total: ${rows.length}   Approved: ${approved}   Rejected: ${rejected}   Pending: ${pending}`,
             ML + 4, yy + 3, { width: usableW - 8, align: 'center' }
           );
        yy += 13;
        let cx = ML;
        cw.forEach((w, i) => {
          doc.rect(cx, yy, w, HRH).fill('#1F3864').stroke('#AAAAAA');
          doc.fillColor('#FFFFFF').fontSize(6.5).font('Helvetica-Bold')
             .text(colHdrs[i], cx + 2, yy + 4, { width: w - 4, align: 'center' });
          cx += w;
        });
        return yy + HRH;
      };

      y = drawPageHeader(y);

      if (rows.length === 0) {
        doc.rect(ML, y, usableW, RH).fill('#FFFFFF').stroke('#CCCCCC');
        doc.fillColor('#888888').fontSize(8).font('Helvetica-Oblique')
           .text('No leave records found for the selected period and filters.', ML, y + 3, { width: usableW, align: 'center' });
      } else {
        rows.forEach((row, idx) => {
          if (y + RH > doc.page.height - 40) {
            doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 28, bottom: 28, left: 28, right: 28 } });
            y = drawPageHeader(28);
          }
          const bg =
            row.status === 'Approved' ? '#D1FAE5' :
            row.status === 'Rejected' ? '#FEE2E2' :
            row.status === 'Pending'  ? '#FFF9C4' :
            (idx % 2 === 0 ? '#FFFFFF' : '#F9F9F9');

          doc.rect(ML, y, usableW, RH).fill(bg).stroke('#DDDDDD');
          let cx = ML;
          colKeys.forEach((key, i) => {
            const val = String(row[key] || '');
            const isCenter = ['empCode','status','hrOverride','days','startDate','endDate'].includes(key);
            const textColor =
              key === 'status'
                ? (row.status === 'Approved' ? '#047857' : row.status === 'Rejected' ? '#B91C1C' : '#B45309')
                : '#000000';
            doc.rect(cx, y, cw[i], RH).stroke('#DDDDDD');
            doc.fillColor(textColor).fontSize(6)
               .font(key === 'status' ? 'Helvetica-Bold' : 'Helvetica')
               .text(val, cx + 2, y + 3, { width: cw[i] - 4, align: isCenter ? 'center' : 'left', lineBreak: false, ellipsis: true });
            cx += cw[i];
          });
          y += RH;
        });
      }

      doc.end();
      return;
    }

    res.status(400).json({ success: false, message: 'format must be excel or pdf' });
  } catch (err) {
    console.error('[LeaveExport]', err);
    res.status(500).json({ success: false, message: 'Leave export failed', error: err.message });
  }
});

// ── dashboard-stats ───────────────────────────────────────────────────────────
router.get('/dashboard-stats', authenticate, async (req,res)=>{
  try{
    const today=new Date().toISOString().split('T')[0];
    const thisMonth=today.substring(0,7);
    const empFilter={};
    if(req.user.role==='employee')     empFilter.emp_id    =toObjId(req.user.id);
    else if(req.user.role==='manager') empFilter.manager_id=toObjId(req.user.id);
    const monthStart=`${thisMonth}-01`;
    const [year,month]=thisMonth.split('-').map(Number);
    const nextMonth=month===12?`${year+1}-01-01`:`${year}-${String(month+1).padStart(2,'0')}-01`;
    const monthlyResult=await AttendanceRecord.aggregate([
      {$match:{date:{$gte:monthStart,$lt:nextMonth},...empFilter}},
      {$group:{_id:null,total:{$sum:1},approved:{$sum:{$cond:[{$eq:['$status','Approved']},1,0]}},pending:{$sum:{$cond:[{$eq:['$status','Pending']},1,0]}},rejected:{$sum:{$cond:[{$eq:['$status','Rejected']},1,0]}},on_duty:{$sum:{$cond:[{$eq:['$duty_type','On Duty']},1,0]}}}},
      {$project:{_id:0}},
    ]);
    const monthly=monthlyResult[0]||{total:0,approved:0,pending:0,rejected:0,on_duty:0};
    const sevenDaysAgo=new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate()-7);
    const trend=await AttendanceRecord.aggregate([
      {$match:{date:{$gte:sevenDaysAgo.toISOString().split('T')[0]},...empFilter}},
      {$group:{_id:'$date',count:{$sum:1},approved:{$sum:{$cond:[{$eq:['$status','Approved']},1,0]}}}},
      {$project:{_id:0,date:'$_id',count:1,approved:1}},
      {$sort:{date:1}},
    ]);
    res.json({success:true,data:{monthly,trend}});
  }catch(err){
    res.status(500).json({success:false,message:'Server error',error:err.message});
  }
});
// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/daily-log-export
//  Single-employee daily log: Date | Check-In | Check-Out | Total Time | Duty Type | Leave Type
//  status: 'All' | 'Today Check-in' | 'Pending' | 'Approved' | 'Rejected'  (mirrors the queue tabs)
//
//  Check-In colour rule:  before 10:00 AM → green (good) | at/after 10:00 AM → red (late)
//  Check-Out colour rule: before 4:00 PM  → red (early)  | at/after 5:30 PM  → green (good)
//                         between 4:00–5:30 PM → neutral (no fill)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/daily-log-export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format='excel', empId, status='All' } = req.query;
    let { startDate, endDate } = req.query;
    const role = req.user.role;

    const targetEmpId = role === 'employee' ? req.user.id : empId;
    if (!targetEmpId)
      return res.status(400).json({success:false,message:'empId is required'});

    const emp = await User.findById(toObjId(targetEmpId))
      .select('_id name emp_id assigned_block assigned_district role_type designation')
      .lean();
    if (!emp) return res.status(404).json({success:false,message:'Employee not found'});

    // "Today Check-in" tab forces the date range to today
    if (status === 'Today Check-in') startDate = endDate = todayIST();
    if (!startDate || !endDate)
      return res.status(400).json({success:false,message:'startDate and endDate are required'});

    const recFilter = { date:{$gte:startDate,$lte:endDate}, emp_id: emp._id };
    if (status && !['All','Today Check-in'].includes(status)) recFilter.status = status;

    let recs = await AttendanceRecord.find(recFilter).sort({date:1}).lean();
    if (status === 'Today Check-in') {
      recs = recs.filter(r =>
        r.checkin_time || r.checkinTime || r.check_in_time || r.checkIn
      );
    }

    // ── Safe time parsing: handles ISO datetime, plain "HH:mm", epoch, or Date ──
    const parseDateTime = (dateStr, timeVal) => {
      if (!timeVal) return null;
      if (timeVal instanceof Date) return isNaN(timeVal) ? null : timeVal;
      if (typeof timeVal === 'number') {
        const d = new Date(timeVal);
        return isNaN(d) ? null : d;
      }
      if (typeof timeVal === 'string') {
        // Full ISO date/datetime string
        if (/^\d{4}-\d{2}-\d{2}/.test(timeVal) || timeVal.includes('T')) {
          const d = new Date(timeVal);
          return isNaN(d) ? null : d;
        }
        // Plain "HH:mm" or "HH:mm:ss" — combine with the record's own date
        const m = timeVal.match(/^(\d{1,2}):(\d{2})(:(\d{2}))?/);
        if (m && dateStr) {
          const d = new Date(`${dateStr}T${m[1].padStart(2,'0')}:${m[2]}:${m[4]||'00'}+05:30`);
          return isNaN(d) ? null : d;
        }
      }
      return null;
    };

    const fmtHM   = mins => `${Math.floor(mins/60)}h ${mins%60}m`;
    const timeStr = d => d ? d.toLocaleTimeString('en-IN',{timeZone:IST,hour:'2-digit',minute:'2-digit',hour12:false}) : '';

    // Threshold buckets — matches the legend (Check-In: 10 AM · Check-Out: 4 PM / 5:30 PM)
    const CHECKIN_CUTOFF = 10*60;         // 10:00 AM in minutes
    const CHECKOUT_EARLY = 16*60;         // 4:00 PM
    const CHECKOUT_FULL  = 17*60 + 30;    // 5:30 PM
    const minsOfDay = d => d.getHours()*60 + d.getMinutes();

    const checkinStatus = d => {
      if (!d) return null;
      return minsOfDay(d) < CHECKIN_CUTOFF ? 'good' : 'late'; // green / red
    };
    const checkoutStatus = d => {
      if (!d) return null;
      const m = minsOfDay(d);
      if (m < CHECKOUT_EARLY) return 'early';   // red
      if (m >= CHECKOUT_FULL) return 'good';    // green
      return null;                              // neutral, between 4–5:30
    };

    const rows = recs.map(r => {
      const ciRaw = r.checkin_time ?? r.checkinTime ?? r.check_in_time ?? r.checkIn;
      const coRaw = r.checkout_time ?? r.checkoutTime ?? r.check_out_time ?? r.checkOut;
      const ci = parseDateTime(r.date, ciRaw);
      const co = parseDateTime(r.date, coRaw);

      let total = '';
      let coDisplay = '';
      if (ci && co) {
        const mins = Math.round((co - ci) / 60000);
        total = mins > 0 ? fmtHM(mins) : '';
        coDisplay = timeStr(co);
      } else if (ci && !co) {
        coDisplay = 'Missed';
      }

      return {
        date: r.date,
        checkin: ci ? timeStr(ci) : '',
        checkout: coDisplay,
        total,
        dutyType: r.duty_type || '',
        leaveType: r.leave_type || '',
        missedCheckout: !!(ci && !co),
        checkinFlag:  checkinStatus(ci),
        checkoutFlag: co ? checkoutStatus(co) : null,
      };
    });

    const workingDays    = rows.filter(r => r.dutyType==='Office Duty' || r.dutyType==='On Duty').length;
    const holidays        = recs.filter(r => (r.duty_type||'').toLowerCase()==='holiday').length;
    const leaves            = recs.filter(r => r.duty_type==='Leave' || (r.leave_type && String(r.leave_type).trim())).length;
    const missedCheckout  = rows.filter(r => r.missedCheckout).length;
    const absent            = recs.filter(r => (r.duty_type||'').toLowerCase()==='absent' ||
                              (r.status==='Rejected' && !(r.checkin_time||r.checkinTime||r.check_in_time||r.checkIn))).length;
    const totalDays         = rows.length;
    const approved           = recs.filter(r => (r.leave_status||r.status)==='Approved').length;
    const pending             = recs.filter(r => (r.leave_status||r.status)==='Pending').length;
    const rejected             = recs.filter(r => (r.leave_status||r.status)==='Rejected').length;

    const headerLine = [emp.emp_id, emp.name, emp.assigned_district, emp.assigned_block]
      .filter(Boolean).join('  |  ');

    // ── Filename helper — used by both formats ────────────────────────────
    const sanitize = s => String(s||'').trim().replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const rangePart = status === 'Today Check-in' ? sanitize(startDate) : `${startDate}_to_${endDate}`;
    const fnameBase = `${sanitize(emp.name)}${emp.emp_id?'_'+sanitize(emp.emp_id):''}_${sanitize(status)}_${rangePart}`;

    // ══════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook(); wb.creator='RAMP AMS';
      const ws = wb.addWorksheet('Daily Log');

      const NAVY   = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1F3864'}};
      const LBLUE  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFDCE6F1'}};
      const GREEN  = {type:'pattern',pattern:'solid',fgColor:{argb:'FF375623'}};
      const GREEN2 = {type:'pattern',pattern:'solid',fgColor:{argb:'FFA9D18E'}};
      const FILL_GOOD = {type:'pattern',pattern:'solid',fgColor:{argb:'FFD1FAE5'}};
      const FILL_LATE = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFEE2E2'}};
      const COLOR_GOOD = 'FF047857';
      const COLOR_LATE = 'FFB91C1C';
      const CBDR = {
        top:{style:'thin',color:{argb:'FFCCCCCC'}}, bottom:{style:'thin',color:{argb:'FFCCCCCC'}},
        left:{style:'thin',color:{argb:'FFCCCCCC'}}, right:{style:'thin',color:{argb:'FFCCCCCC'}},
      };

     const COLS = ['Date','Check-In','Check-Out','Total Time','Duty Type','Leave Type'];

// Row 1 — employee info banner
ws.mergeCells(1,1,1,COLS.length);
Object.assign(ws.getCell(1,1),{
  value:headerLine,
  font:{bold:true,size:12,color:{argb:'FFFFFFFF'}},
  fill:NAVY,
  alignment:{horizontal:'left',vertical:'center'},
});
ws.getRow(1).height=22;

// Row 2 — filter/period line
ws.mergeCells(2,1,2,COLS.length);
Object.assign(ws.getCell(2,1),{
  value: `Filter: ${status}   |   Period: ${status==='Today Check-in' ? startDate : `${startDate} to ${endDate}`}`,
  font:{italic:true,size:9,color:{argb:'FF555555'}},
  alignment:{horizontal:'left',vertical:'center'},
});
ws.getRow(2).height=15;

// Row 3 — column headers (THIS is the block that must run, once, for ALL 6 columns)
COLS.forEach((h,i)=>{
  const c=ws.getCell(3,i+1);
  c.value = h;
  c.font  = {bold:true,size:10,color:{argb:'FF1F3864'}};
  c.fill  = LBLUE;
  c.border = CBDR;
  c.alignment = {horizontal:'center',vertical:'center'};
  ws.getColumn(i+1).width = i===0?12:i===3?12:16;
});

// Data rows start at row 4
rows.forEach((r,idx)=>{
  const rn=4+idx;
        [r.date,r.checkin,r.checkout,r.total,r.dutyType,r.leaveType].forEach((v,i)=>{
          const c=ws.getCell(rn,i+1);
          c.value=v||''; c.border=CBDR; c.font={size:10};
          c.alignment={horizontal:i===0?'left':'center',vertical:'center'};

          // Column 2 (index 1) = Check-In, Column 3 (index 2) = Check-Out
          if (i===1 && r.checkinFlag) {
            c.fill = r.checkinFlag==='good' ? FILL_GOOD : FILL_LATE;
            c.font = {size:10, bold:true, color:{argb: r.checkinFlag==='good' ? COLOR_GOOD : COLOR_LATE}};
          }
          if (i===2 && r.checkoutFlag) {
            c.fill = r.checkoutFlag==='good' ? FILL_GOOD : FILL_LATE;
            c.font = {size:10, bold:true, color:{argb: r.checkoutFlag==='good' ? COLOR_GOOD : COLOR_LATE}};
          }
        });
      });

      let r = 4+rows.length+1;
      ws.mergeCells(r,1,r,COLS.length);
      Object.assign(ws.getCell(r,1),{
        value:`Working Days: ${workingDays}  |  Holidays: ${holidays}  |  Leaves: ${leaves}  |  Missed Checkout: ${missedCheckout}  |  Absent: ${absent}  |  Total: ${totalDays} days`,
        font:{bold:true,size:10,color:{argb:'FFFFFFFF'}}, fill:GREEN, alignment:{horizontal:'left',vertical:'center'},
      });
      ws.getRow(r).height=18;

      r++;
      ws.mergeCells(r,1,r,COLS.length);
      Object.assign(ws.getCell(r,1),{
        value:`Approved: ${approved}  |  Pending: ${pending}  |  Rejected: ${rejected}`,
        font:{bold:true,size:10,color:{argb:'FF1F3864'}}, fill:GREEN2, alignment:{horizontal:'left',vertical:'center'},
      });
      ws.getRow(r).height=18;

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${fnameBase}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════
    if (format === 'pdf') {
      const doc = new PDFDoc({size:'A4',layout:'portrait',margins:{top:30,bottom:30,left:30,right:30}});
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${fnameBase}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
      doc.pipe(res);

      const ML=30, PW=doc.page.width-60;
      doc.rect(ML,ML,PW,22).fill('#1F3864');
      doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold').text(headerLine,ML+6,ML+6,{width:PW-12});

      let y = ML+22;
      doc.fillColor('#555555').fontSize(8).font('Helvetica-Oblique')
         .text(`Filter: ${status}   |   Period: ${status==='Today Check-in' ? startDate : `${startDate} to ${endDate}`}`,ML,y+3,{width:PW});
      y += 16;

      const colX=[ML, ML+70, ML+150, ML+230, ML+310, ML+410];
      const colW=[70,80,80,80,100,80];
    ['Date','Check-In','Check-Out','Total Time','Duty Type','Leave Type'].forEach((h,i)=>{
  doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold')
     .text(h, colX[i]+2, y+4, { width: colW[i]-4, align: 'center' });
});
y += 16;

      rows.forEach((r,idx)=>{
        if (y+14>doc.page.height-100){doc.addPage();y=30;}
        doc.rect(ML,y,PW,14).fill(idx%2===0?'#FFFFFF':'#F7F7F7').stroke('#DDDDDD');
        [r.date,r.checkin,r.checkout,r.total,r.dutyType,r.leaveType].forEach((v,i)=>{
          let color = '#000000';
          if (i===1 && r.checkinFlag)  color = r.checkinFlag==='good'  ? '#047857' : '#B91C1C';
          if (i===2 && r.checkoutFlag) color = r.checkoutFlag==='good' ? '#047857' : '#B91C1C';
          doc.fillColor(color).fontSize(7.5).font(color==='#000000' ? 'Helvetica' : 'Helvetica-Bold')
             .text(String(v||''),colX[i]+2,y+3,{width:colW[i]-4,align:i===0?'left':'center',lineBreak:false,ellipsis:true});
        });
        y+=14;
      });

      y+=6;
      doc.rect(ML,y,PW,18).fill('#375623');
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
         .text(`Working Days: ${workingDays}  |  Holidays: ${holidays}  |  Leaves: ${leaves}  |  Missed Checkout: ${missedCheckout}  |  Absent: ${absent}  |  Total: ${totalDays} days`,ML+6,y+5,{width:PW-12});
      y+=18;
      doc.rect(ML,y,PW,18).fill('#A9D18E');
      doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold')
         .text(`Approved: ${approved}  |  Pending: ${pending}  |  Rejected: ${rejected}`,ML+6,y+5,{width:PW-12});

      doc.end();
      return;
    }

    res.status(400).json({success:false,message:'format must be excel or pdf'});
  } catch(err){
    console.error('[DailyLogExport]',err);
    res.status(500).json({success:false,message:'Export failed',error:err.message});
  }
});
module.exports = router;