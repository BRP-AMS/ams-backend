require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, AttendanceRecord, Notification, AuditLog, connectionPromise } = require('./src/models/database');

const seed = async () => {
  await connectionPromise;
  console.log('🌱 Seeding database with user provided credentials...');

  await Promise.all([
    AuditLog.deleteMany({}),
    Notification.deleteMany({}),
    AttendanceRecord.deleteMany({}),
    User.deleteMany({}),
  ]);

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const commonPassword = 'Pass@123';
  const hashedPw = hash(commonPassword);

  const users = [
    { emp_id: 'SADM001', name: 'Super Admin', email: 'ajaynarasimhareddy.5252@gmail.com', role: 'super_admin', department: 'Executive' },
    { emp_id: 'ADM001',  name: 'Admin One',   email: 'ajay.rges@gmail.com',            role: 'admin',       department: 'Administration' },
    { emp_id: 'USR003',  name: 'Employee One', email: 'ajayasiriyapureddy14348@gmail.com', role: 'employee',    department: 'Engineering' },
    { emp_id: 'USR004',  name: 'Employee Two', email: 'ajaysreeyapureddy14348@gmail.com', role: 'employee',    department: 'Engineering' },
    { emp_id: 'USR005',  name: 'Employee Three', email: 'ajaysreeyapureddy854@gmail.com',  role: 'employee',    department: 'Sales' },
    { emp_id: 'USR006',  name: 'Employee Four', email: 'vuln.inf0@gmail.com',           role: 'employee',    department: 'Marketing' },
    { emp_id: 'MGR01',   name: 'Manager One',  email: 'ajay.siriyapu@gmail.com',        role: 'manager',     department: 'Engineering' },
    { emp_id: 'USR008',  name: 'Employee Five', email: '19kb5a0260@nbkrist.org',         role: 'employee',    department: 'Support' },
    { emp_id: 'USR009',  name: 'Employee Six',  email: 'chandunath2208@gmail.com',       role: 'employee',    department: 'Support' },
    { emp_id: 'USR010',  name: 'HR One',        email: 'info@raminfo.com',               role: 'hr',          department: 'HR' },
    { emp_id: 'USR011',  name: 'Admin Two',     email: 'tenders@raminfo.com',            role: 'admin',       department: 'Administration' },
  ];

  const userDocs = users.map(u => ({
    ...u,
    _id: uuidv4(),
    password_hash: hashedPw,
    phone: '9876543210',
    is_active: 1,
    email_verified: true,
    phone_verified: true,
    assigned_block: 'Block A',
    assigned_district: 'District 1'
  }));

  // Link employees to the manager
  const mgrDoc = userDocs.find(u => u.role === 'manager');
  userDocs.forEach(u => {
    if (u.role === 'employee' && mgrDoc) {
      u.manager_id = mgrDoc._id;
    }
  });

  await User.insertMany(userDocs);

  console.log('✅ Database seeded with user credentials successfully!');
  console.log('\n📋 Updated Login Credentials:');
  console.log('  Password for all: ' + commonPassword);
  users.forEach(u => {
    console.log(`  ${u.role.padEnd(12)}: ${u.email} (${u.emp_id})`);
  });

  process.exit(0);
};

seed().catch(err => { console.error(err); process.exit(1); });
