const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, connectionPromise } = require('./src/models/database');

const seed = async () => {
  await connectionPromise;
  console.log('🌱 Seeding database...\n');

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const pw = 'Pass@123';
  const norm = (e) => e.trim().toLowerCase();

  const users = [
    { emp_id: 'SADM001', name: 'Ajaya Narasimha Reddy', email: norm('ajaynarasimhareddy.5252@gmail.com'), role: 'super_admin', department: 'Administration', manager_id: null, phone: '9000000001' },
    { emp_id: 'ADM001',  name: 'Ajay Admin',            email: norm('ajay.rges@gmail.com'),               role: 'admin',       department: 'Administration', manager_id: null, phone: '9000000002' },
    { emp_id: 'USR003',  name: 'Ajay S',                email: norm('ajayasiriyapureddy14348@gmail.com'),  role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000003' },
    { emp_id: 'USR004',  name: 'Ajay Sreya',            email: norm('ajaysreeyapureddy14348@gmail.com'),   role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000004' },
    { emp_id: 'USR005',  name: 'Ajay Sreya 2',          email: norm('ajaysreeyapureddy854@gmail.com'),     role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000005' },
    { emp_id: 'USR006',  name: 'Vuln Finder',           email: norm('vuln.inf0@gmail.com'),                role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000006' },
    { emp_id: 'MGR01',   name: 'Ajay Siriyapu',         email: norm('ajay.siriyapu@gmail.com'),            role: 'manager',     department: 'Field Operations', manager_id: null, phone: '9000000007', assigned_block: 'Agartala', assigned_district: 'West Tripura' },
    { emp_id: 'USR008',  name: 'NB Krist',              email: norm('19kb5a0260@nbkrist.org'),             role: 'employee',    department: 'Field Operations', manager_id: null, phone: '9000000008' },
    { emp_id: 'USR009',  name: 'Chandu Nath',           email: norm('chandunath2208@gmail.com'),           role: 'employee',    department: 'Field Operations', manager_id: null, phone: '9000000009' },
    { emp_id: 'USR010',  name: 'Raminfo Admin',         email: norm('info@raminfo.com'),                   role: 'hr',          department: 'Head Office Operations', manager_id: null, phone: '9000000010' },
    { emp_id: 'USR011',  name: 'Raminfo Tenders',       email: norm('tenders@raminfo.com'),                role: 'admin',       department: 'Head Office Operations', manager_id: null, phone: '9000000011' },
  ];

  // Delete old dummy seed users
  const dummyEmpIds = ['HR001', 'MGR001', 'MGR002', 'EMP001', 'EMP002', 'EMP003', 'EMP004'];
  const deleted = await User.deleteMany({ emp_id: { $in: dummyEmpIds } });
  console.log(`Deleted ${deleted.deletedCount} dummy users`);

  let created = 0, updated = 0;
  for (const u of users) {
    const existing = await User.findOne({ $or: [{ emp_id: u.emp_id }, { email: u.email }] });
    if (existing) {
      await User.findByIdAndUpdate(existing._id, { $set: { ...u, is_active: 1, email_verified: true, password_hash: hash(pw) } });
      console.log(`  ♻️  Updated: ${u.emp_id} — ${u.name} (${u.role}) — ${u.email}`);
      updated++;
    } else {
      await User.create({ _id: uuidv4(), ...u, password_hash: hash(pw), is_active: 1, email_verified: true });
      console.log(`  ✅ Created: ${u.emp_id} — ${u.name} (${u.role}) — ${u.email}`);
      created++;
    }
  }

  console.log(`\n✅ Seed complete! Created: ${created}, Updated: ${updated}`);
  console.log(`\n📋 Login Credentials (password: ${pw})`);
  console.log('─────────────────────────────────────────────────────────────');
  users.forEach(u => {
    console.log(`  ${u.role.padEnd(14)} ${u.emp_id.padEnd(9)} ${u.email}`);
  });
  console.log('─────────────────────────────────────────────────────────────');
  process.exit(0);
};

seed().catch(err => { console.error('❌ Seed failed:', err); process.exit(1); });
