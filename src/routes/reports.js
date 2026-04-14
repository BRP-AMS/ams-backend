const express      = require('express');
const router       = express.Router();
const XLSX         = require('xlsx');
const PDFDocument  = require('pdfkit');
const { AttendanceRecord } = require('../models/database');
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
  'Dhalai','Gomati','Khowai','North Tripura','Sepahijala',
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

const isWeekend = iso => { const d=new Date(iso+'T00:00:00+05:30').getDay(); return d===0||d===6; };
const dayNum    = iso => new Date(iso+'T00:00:00+05:30').getDate();
const monAbbr   = iso => new Date(iso+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,month:'short'});
const ordinal   = n   => { const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };
const colLetter = n   => { let s='',c=n; while(c>0){s=String.fromCharCode(65+(c-1)%26)+s;c=Math.floor((c-1)/26);} return s; };

/**
 * toCode — determines cell code for one attendance record
 *
 * @param rec            - AttendanceRecord or null/undefined
 * @param assignedBlock  - employee's assigned block (from User.assigned_block)
 * @param assignedDistrict - employee's assigned district (from User.assigned_district)
 */
const toCode = (rec, assignedBlock, assignedDistrict) => {
  if (!rec) return 'A';                         // no check-in → Absent
  if (rec.duty_type === 'Leave') return 'L';
  if (rec.status === 'Rejected') return 'A';    // rejected = absent/LOP

  const addr = rec.location_address || rec.locationAddress || '';

  // ── No assignment: default to P (can't determine, treat as present) ──────
  if (!assignedBlock && !assignedDistrict) return 'P';

  // ── Has assignment: check if location matches assigned block/district ─────
  const matchesAssigned =
    (assignedBlock    && matchesLocation(addr, assignedBlock))   ||
    (assignedDistrict && matchesLocation(addr, assignedDistrict));

  if (matchesAssigned) return 'P';   // at assigned workplace → Present

  // ── In Tripura but not at assigned location → On Duty elsewhere ───────────
  if (isInTripura(addr)) return 'OD';

  // ── Outside all known Tripura locations → blank (outside service area) ────
  return '';
};

// ══════════════════════════════════════════════════════════════════════════════
router.get('/export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format='excel', status } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate||!endDate)
      return res.status(400).json({success:false,message:'startDate and endDate are required'});

    // Cap endDate to yesterday — today is never shown
    if (endDate >= todayIST()) endDate = yesterdayIST();
    if (startDate > endDate)
      return res.status(400).json({success:false,message:'No completed dates in range. Report covers up to yesterday.'});

    const dates      = expandDates(startDate, endDate);
    const multiMonth = new Date(startDate+'T00:00:00+05:30').getMonth() !==
                       new Date(endDate  +'T00:00:00+05:30').getMonth();
    const totalDays  = dates.length;
    const woCount    = dates.filter(isWeekend).length;

    // ── Employee list — include assigned_block, assigned_district, created_at ─
    let employees = [];
    if (role==='employee') {
      const me = await User.findById(req.user.id)
        .select('_id name emp_id created_at assigned_block assigned_district').lean();
      if (me) employees = [me];
    } else if (role==='manager') {
      employees = await User.find({ manager_id:toObjId(req.user.id), is_active:{$ne:false} })
        .select('_id name emp_id created_at assigned_block assigned_district').sort({emp_id:1}).lean();
    } else {
      employees = await User.find({ role:'employee', is_active:{$ne:false} })
        .select('_id name emp_id created_at assigned_block assigned_district').sort({emp_id:1}).lean();
    }
    if (!employees.length)
      return res.status(404).json({success:false,message:'No employees found'});

    // ── Manager name for signature ─────────────────────────────────────────
    let managerName = '';
    if (role==='manager') {
      const mgr = await User.findById(req.user.id).select('name').lean();
      managerName = mgr?.name || '';
    } else if (role==='employee') {
      const emp = await User.findById(req.user.id).select('manager_id').lean();
      if (emp?.manager_id) {
        const mgr = await User.findById(emp.manager_id).select('name').lean();
        managerName = mgr?.name || '';
      }
    } else {
      // admin/hr/super_admin — no single manager; leave blank
    }

    // ── Attendance records ─────────────────────────────────────────────────
    const recFilter = {
      date:   {$gte:startDate,$lte:endDate},
      emp_id: {$in:employees.map(e=>e._id)},
    };
    if (status&&status!=='All') recFilter.status = status;
    const rawRecs = await AttendanceRecord.find(recFilter).lean();

    const recIdx = {};
    for (const r of rawRecs) {
      const eid = String(r.emp_id);
      if (!recIdx[eid]) recIdx[eid] = {};
      recIdx[eid][r.date] = r;
    }

    // ── Build cell matrix ─────────────────────────────────────────────────
    const matrix = employees.map(emp => {
      const joinDate = emp.created_at
        ? new Date(emp.created_at).toLocaleDateString('en-CA', { timeZone: IST })
        : null;
      const ab = emp.assigned_block    || null;
      const ad = emp.assigned_district || null;

      return {
        emp,
        cells: dates.map(iso => {
          if (isWeekend(iso))                    return 'WO';
          if (joinDate && iso < joinDate)        return '';   // pre-join → blank
          const rec = recIdx[String(emp._id)]?.[iso];
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

    // ══════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════
    if (format==='excel') {
      const wb = new ExcelJS.Workbook(); wb.creator='RAMP AMS';

      const FILL_RED  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFF4444'}};
      const FILL_WO   = {type:'pattern',pattern:'solid',fgColor:{argb:'FFBDD7EE'}};
      const FILL_WHT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFFFF'}};
      const FILL_ALT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF7F7F7'}};
      const FILL_SUBH = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE8EDF4'}};

      const codeFill = (code,rf) => {
        if (code==='L'||code==='A') return FILL_RED;
        if (code==='WO')            return FILL_WO;
        return rf;
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

      const buildSheet = (ws, empList, sheetTitle, mgrName) => {
        const LAST = 3+dates.length;

        // ── Rows 1-3: header ────────────────────────────────────────────
        mc(ws,1,2,1,LAST);
        Object.assign(ws.getCell(1,2),{value:'Attendance details of BRP',font:{bold:true,size:13,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(1).height=24;

        mc(ws,2,2,2,LAST);
        Object.assign(ws.getCell(2,2),{value:rangeTitle,font:{bold:true,size:11,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(2).height=18;

        const half=2+Math.floor(dates.length/2);
        mc(ws,3,2,3,half-1);
        Object.assign(ws.getCell(3,2),{value:'Location Name: Tripura',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        mc(ws,3,half,3,LAST);
        Object.assign(ws.getCell(3,half),{value:'Project Name: Block Resource Person',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        ws.getRow(3).height=16;

        // ── Row 4: column headers ───────────────────────────────────────
        ws.getRow(4).height=multiMonth?30:18;
        ws.getColumn(2).width=9; ws.getColumn(3).width=16;
        const HF={bold:true,size:9,color:{argb:'FF3366FF'},name:'Calibri'};
        const setHdr=(col,val)=>{
          const c=ws.getCell(4,col); c.value=val; c.font=HF; c.fill=FILL_WHT; c.border=CBDR;
          c.alignment={horizontal:'center',vertical:'center',wrapText:multiMonth&&col>3};
          ws.getColumn(col).width=col===2?9:col===3?16:4.2;
        };
        setHdr(2,'Emp code'); setHdr(3,'Employee Name');
        dates.forEach((iso,i)=>setHdr(4+i,multiMonth?`${dayNum(iso)}\n${monAbbr(iso)}`:String(dayNum(iso))));

        // ── Data rows ───────────────────────────────────────────────────
        empList.forEach(({emp,cells},idx)=>{
          const rowN=5+idx; ws.getRow(rowN).height=15;
          const rf=idx%2===0?FILL_WHT:FILL_ALT;
          const c2=ws.getCell(rowN,2); c2.value=emp.emp_id; c2.border=CBDR; c2.fill=rf; c2.alignment={horizontal:'center',vertical:'center',wrapText:false}; c2.font={size:10,name:'Calibri'}; c2.protection={locked:true};
          const c3=ws.getCell(rowN,3); c3.value=emp.name;   c3.border=CBDR; c3.fill=rf; c3.alignment={horizontal:'left',  vertical:'center',wrapText:false}; c3.font={size:10,name:'Calibri'}; c3.protection={locked:true};
          cells.forEach((code,i)=>{
            const c=ws.getCell(rowN,4+i); c.value=code; c.border=CBDR;
            c.alignment={horizontal:'center',vertical:'center',wrapText:false};
            c.font={bold:!!code,size:9,name:'Calibri',color:{argb:(code==='L'||code==='A')?'FFFFFFFF':'FF000000'}};
            c.fill=codeFill(code,rf); c.protection={locked:true};
          });
        });

        // ── Legend ──────────────────────────────────────────────────────
        const legendRow=5+empList.length+1; ws.getRow(legendRow).height=14;
        [{code:'P',label:'Present (assigned location)',isRed:false},
         {code:'OD',label:'On Duty (other Tripura location)',isRed:false},
         {code:'L',label:'Leave',isRed:true},
         {code:'A',label:'Absent',isRed:true},
         {code:'WO',label:'Week Off',isRed:false},
        ].forEach(({code,label,isRed},i)=>{
          const cc=ws.getCell(legendRow,4+i*2);
          cc.value=code; cc.fill=isRed?FILL_RED:FILL_WHT; cc.border=CBDR;
          cc.alignment={horizontal:'center',vertical:'center'};
          cc.font={bold:true,size:8,name:'Calibri',color:{argb:isRed?'FFFFFFFF':'FF000000'}};
          ws.getCell(legendRow,4+i*2+1).value=label;
          ws.getCell(legendRow,4+i*2+1).font={size:8,name:'Calibri',italic:true};
        });

        // ── Summary ─────────────────────────────────────────────────────
        const fDC=colLetter(4), lDC=colLetter(3+dates.length);
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
        const subHdr=label=>{
          r++; ws.getRow(r).height=17; mc(ws,r,2,r,3);
          Object.assign(ws.getCell(r,2),{value:label,fill:FILL_SUBH,font:{bold:true,size:10,color:{argb:'FF1F3864'},name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        };

        sumRow('No of Total Days',totalDays);
        sumRow('No of Weekoff (WO)',woCount);
        sumRow('No of Holidays (H)',0);

        if(empList.length===1){
          const er=5;
          sumRow('No of Present / worked (P+OD)',`=COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")`);
          sumRow('No of Leaves (L)',`=COUNTIF(${fDC}${er}:${lDC}${er},"L")`);
          sumRow('No of Absent (A)',`=COUNTIF(${fDC}${er}:${lDC}${er},"A")`);
        } else {
          subHdr('No of present / Worked');
          empList.forEach(({emp},idx)=>{ const er=5+idx; sumRow(emp.name,`=COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")`); });
          subHdr('No of Leaves');
          empList.forEach(({emp},idx)=>{ const er=5+idx; sumRow(emp.name,`=COUNTIF(${fDC}${er}:${lDC}${er},"L")`); });
          subHdr('No of Absent');
          empList.forEach(({emp},idx)=>{ const er=5+idx; sumRow(emp.name,`=COUNTIF(${fDC}${er}:${lDC}${er},"A")`); });
        }

        outerBorder(ws,SR,2,r,3);

        // ── ✅ Employee Sign (left) + Manager Sign (right) — side by side ──
     // ── Signatures ───────────────────────────────────────────────────────
r+=3; ws.getRow(r).height=20;

if (role === 'employee') {
  // Employee download: show BOTH employee sign (left) + manager sign (right)
  ws.getCell(r,2).value='Employee Sign:';
  ws.getCell(r,2).font={bold:true,size:10,name:'Calibri',color:{argb:'FF1F3864'}};
  mc(ws,r,3,r,6);
  const empSigCell=ws.getCell(r,3);
  empSigCell.value='';
  empSigCell.alignment={horizontal:'center',vertical:'bottom'};
  empSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};

  ws.getCell(r,8).value='Manager Sign:';
  ws.getCell(r,8).font={bold:true,size:20,name:'Calibri',color:{argb:'FF1F3864'}};
  mc(ws,r,9,r,13);
  const mgrSigCell=ws.getCell(r,9);
  mgrSigCell.value=mgrName?`(${mgrName})`:'';
  mgrSigCell.font={italic:true,size:10,name:'Calibri',color:{argb:'FF555555'}};
  mgrSigCell.alignment={horizontal:'center',vertical:'bottom'};
  mgrSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};
} else {
  // Manager / super_admin / hr / admin: only Manager sign
  ws.getCell(r,2).value='Manager Sign:';
  ws.getCell(r,2).font={bold:true,size:10,name:'Calibri',color:{argb:'FF1F3864'}};
  mc(ws,r,3,r,8);
  const mgrSigCell=ws.getCell(r,3);
  mgrSigCell.value=mgrName?`(${mgrName})`:'';
  mgrSigCell.font={italic:true,size:10,name:'Calibri',color:{argb:'FF555555'}};
  mgrSigCell.alignment={horizontal:'center',vertical:'bottom'};
  mgrSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};
}

        ws.views=[{state:'frozen',xSplit:3,ySplit:4}];
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
        buildSheet(wb.addWorksheet('My Attendance'),matrix,`${matrix[0]?.emp.name} Summary`,managerName);
      } else {
        const allName =role==='manager'?'Team Report':'All emp Reports';
        const allTitle=role==='manager'?'Team Summary':'Total Summary';
        buildSheet(wb.addWorksheet(allName),matrix,allTitle,managerName);
        matrix.forEach(({emp,cells})=>{
          const name=emp.name.replace(/[:\\/?*[\]]/g,'').substring(0,31);
          buildSheet(wb.addWorksheet(name),[{emp,cells}],`${emp.name} Summary`,managerName);
        });
      }

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="BRP_Attendance_${startDate}_to_${endDate}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════
    if(format==='pdf'){
      const doc=new PDFDoc({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},autoFirstPage:true});
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="BRP_Attendance_${startDate}_to_${endDate}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const PW=doc.page.width,PH=doc.page.height,ML=28;
      const CC=52,CN=115,CT=36;
      const dW=Math.max(11,(PW-56-CC-CN-CT)/dates.length);
      const RH=14;
      const xC=ML,xN=ML+CC,xD=xN+CN,xT=xD+dates.length*dW,tW=xT+CT-ML;

      const addPage=()=>doc.addPage({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28}});

      const drawHdr=y=>{
        doc.rect(ML,y,tW,20).fill('#FFF').stroke('#AAA');
        doc.fillColor('#000').fontSize(12).font('Helvetica-Bold').text('Attendance details of BRP',ML,y+5,{width:tW,align:'center'});
        doc.rect(ML,y+20,tW,14).fill('#FFF').stroke('#AAA');
        doc.fillColor('#666').fontSize(8).font('Helvetica').text(rangeTitle,ML,y+23,{width:tW,align:'center'});
        doc.rect(ML,y+34,tW,12).fill('#FFF').stroke('#AAA');
        doc.fillColor('#000').fontSize(7).font('Helvetica-Bold')
           .text('Location: Tripura',ML+4,y+37).text('Project: Block Resource Person',ML+tW/2,y+37);
        const y2=y+46;
        [[xC,CC,'Emp code'],[xN,CN,'Employee Name']].forEach(([x,w,l])=>{
          doc.rect(x,y2,w,RH).fill('#FFF').stroke('#AAA');
          doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold').text(l,x+2,y2+3,{width:w-4,align:'center'});
        });
        dates.forEach((iso,i)=>{
          const x=xD+i*dW;
          doc.rect(x,y2,dW,RH).fill('#FFF').stroke('#AAA');
          doc.fillColor('#3366FF').fontSize(6).font('Helvetica-Bold').text(String(dayNum(iso)),x+1,y2+3,{width:dW-2,align:'center'});
        });
        doc.rect(xT,y2,CT,RH).fill('#FFF').stroke('#AAA');
        doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold').text('Total',xT+2,y2+3,{width:CT-4,align:'center'});
        return y2+RH;
      };

      let y=drawHdr(ML);
      matrix.forEach(({emp,cells},idx)=>{
        if(y+RH>PH-60){addPage();y=drawHdr(28);}
        const bg=idx%2===0?'#F9F9F9':'#FFF';
        doc.rect(ML,y,tW,RH).fill(bg).stroke('#CCC');
        doc.fillColor('#000').fontSize(7).font('Helvetica').text(emp.emp_id||'',xC+2,y+3,{width:CC-4,align:'center'});
        doc.font('Helvetica-Bold').text(emp.name,xN+2,y+3,{width:CN-4});
        let pres=0;
        cells.forEach((code,i)=>{
          const x=xD+i*dW;
          const isRed=code==='L'||code==='A';
          const cellBg=isRed?'#FF4444':code==='WO'?'#BDD7EE':bg;
          doc.rect(x,y,dW,RH).fill(cellBg).stroke('#CCC');
          if(code){
            doc.fillColor(isRed?'#FFFFFF':'#000000').fontSize(6).font('Helvetica-Bold')
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
       {code:'L',label:'Leave',red:true},
       {code:'A',label:'Absent',red:true},
       {code:'WO',label:'Week Off',red:false},
      ].forEach(({code,label,red})=>{
        const bw=14,lw=72;
        doc.rect(lx,y,bw,10).fill(red?'#FF4444':'#FFFFFF').stroke('#999');
        doc.fillColor(red?'#FFFFFF':'#000000').fontSize(6).font('Helvetica-Bold').text(code,lx+1,y+2,{width:bw-2,align:'center'});
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
      pdfRow('No of Holidays (H)',0);
      if(matrix.length===1){
        const cells=matrix[0].cells;
        pdfRow('No of Present / worked (P+OD)',cells.filter(c=>c==='P'||c==='OD').length);
        pdfRow('No of Leaves (L)',cells.filter(c=>c==='L').length);
        pdfRow('No of Absent (A)',cells.filter(c=>c==='A').length);
      } else {
        pdfRow('No of present / Worked',undefined,'sub');
        matrix.forEach(({emp,cells})=>pdfRow(emp.name,cells.filter(c=>c==='P'||c==='OD').length));
        pdfRow('No of Leaves',undefined,'sub');
        matrix.forEach(({emp,cells})=>pdfRow(emp.name,cells.filter(c=>c==='L').length));
        pdfRow('No of Absent',undefined,'sub');
        matrix.forEach(({emp,cells})=>pdfRow(emp.name,cells.filter(c=>c==='A').length));
      }

      // ✅ Employee sign (left) + Manager sign (right) — side by side
   // ── Signatures ───────────────────────────────────────────────────────
sy+=24; if(sy+30>PH-28){addPage();sy=40;}
const sigLineW=140;

if (role === 'employee') {
  // Employee download: Employee sign left + Manager sign right
  doc.fillColor('#1F3864').fontSize(16).font('Helvetica-Bold')
     .text('Employee Sign:',ML,sy);
  doc.moveTo(ML+90,sy+12).lineTo(ML+90+sigLineW,sy+12).stroke('#1F3864');

  const mgrSigX=ML+90+sigLineW+60;
  doc.fillColor('#1F3864').fontSize(16).font('Helvetica-Bold')
     .text('Manager Sign:',mgrSigX,sy);
  doc.moveTo(mgrSigX+90,sy+12).lineTo(mgrSigX+90+sigLineW,sy+12).stroke('#1F3864');
  if(managerName){
    doc.fillColor('#555').fontSize(20).font('Helvetica-Oblique')
       .text(`(${managerName})`,mgrSigX+90,sy+14,{width:sigLineW,align:'center'});
  }
} else {
  // Manager / super_admin / hr: only Manager sign
  doc.fillColor('#1F3864').fontSize(16).font('Helvetica-Bold')
     .text('Manager Sign:',ML,sy);
  doc.moveTo(ML+90,sy+12).lineTo(ML+90+sigLineW,sy+12).stroke('#1F3864');
  if(managerName){
    doc.fillColor('#555').fontSize(15).font('Helvetica-Oblique')
       .text(`(${managerName})`,ML+90,sy+14,{width:sigLineW,align:'center'});
  }
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


// ── Upload Report Document ─────────────────────────────────────────

const multer = require("multer");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

router.post(
  "/upload",
  authenticate,
  upload.single("document"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded"
        });
      }

      res.json({
        success: true,
        filename: req.file.filename
      });

    } catch (err) {

      res.status(500).json({
        success: false,
        message: "Upload failed"
      });

    }

  }
);

module.exports = router;