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
  const pw = 'R@m%Brp@26';

  // ── Pre-generate IDs ──────────────────────────────────────────────────
  const superAdminId = uuidv4();
  const adminId      = uuidv4();
  const hrId         = uuidv4();
  const mgr1Id       = uuidv4();
  const mgr2Id       = uuidv4();
  const emp1Id       = uuidv4();
  const emp2Id       = uuidv4();
  const emp3Id       = uuidv4();
  const emp4Id       = uuidv4();

  // ── Seed users (upsert by emp_id — won't duplicate) ────────────────────
  const users = [
    // ─── Super Admin ─────────────────────────────────────────────────────
    {
      _id: superAdminId, emp_id: 'SADM001',
      name: 'Super Admin', email: 'ajay.s@raminfo.com',
      password_hash: hash(pw), role: 'super_admin',
      department: 'Administration', manager_id: null,
      phone: '9000000001', assigned_block: null, assigned_district: null,
      email_verified: true,
    },
    // ─── Admin ───────────────────────────────────────────────────────────
    {
      _id: adminId, emp_id: 'ADM001',
      name: 'Admin User', email: 'ajay.rges@gmail.com',
      password_hash: hash(pw), role: 'admin',
      department: 'Administration', manager_id: null,
      phone: '9000000002', assigned_block: null, assigned_district: null,
      email_verified: true,
    },
    // ─── HR ──────────────────────────────────────────────────────────────
    {
      _id: hrId, emp_id: 'HR001',
      name: 'HR Manager', email: 'hr.brpams@gmail.com',
      password_hash: hash(pw), role: 'hr',
      department: 'Human Resources', manager_id: null,
      phone: '9000000003', assigned_block: null, assigned_district: null,
      email_verified: true,
    },
    // ─── Manager 1 ──────────────────────────────────────────────────────
    {
      _id: mgr1Id, emp_id: 'MGR001',
      name: 'Rajesh Kumar', email: 'mgr1.brpams@gmail.com',
      password_hash: hash(pw), role: 'manager',
      department: 'Field Operations', manager_id: null,
      phone: '9000000004', assigned_block: 'Agartala', assigned_district: 'West Tripura',
      email_verified: true,
    },
    // ─── Manager 2 ──────────────────────────────────────────────────────
    {
      _id: mgr2Id, emp_id: 'MGR002',
      name: 'Priya Sharma', email: 'mgr2.brpams@gmail.com',
      password_hash: hash(pw), role: 'manager',
      department: 'Marketing', manager_id: null,
      phone: '9000000005', assigned_block: 'Udaipur', assigned_district: 'South Tripura',
      email_verified: true,
    },
    // ─── Employee 1 (under Manager 1) ────────────────────────────────────
    {
      _id: emp1Id, emp_id: 'EMP001',
      name: 'Amit Das', email: 'emp1.brpams@gmail.com',
      password_hash: hash(pw), role: 'employee',
      department: 'Field Operations', manager_id: mgr1Id,
      phone: '9000000006', assigned_block: 'Agartala', assigned_district: 'West Tripura',
      email_verified: true,
    },
    // ─── Employee 2 (under Manager 1) ────────────────────────────────────
    {
      _id: emp2Id, emp_id: 'EMP002',
      name: 'Suman Deb', email: 'emp2.brpams@gmail.com',
      password_hash: hash(pw), role: 'employee',
      department: 'Field Operations', manager_id: mgr1Id,
      phone: '9000000007', assigned_block: 'Block A', assigned_district: 'West Tripura',
      email_verified: true,
    },
    // ─── Employee 3 (under Manager 2) ────────────────────────────────────
    {
      _id: emp3Id, emp_id: 'EMP003',
      name: 'Ritu Nath', email: 'emp3.brpams@gmail.com',
      password_hash: hash(pw), role: 'employee',
      department: 'Marketing', manager_id: mgr2Id,
      phone: '9000000008', assigned_block: 'Udaipur', assigned_district: 'South Tripura',
      email_verified: true,
    },
    // ─── Employee 4 (under Manager 2) ────────────────────────────────────
    {
      _id: emp4Id, emp_id: 'EMP004',
      name: 'Bikram Reang', email: 'emp4.brpams@gmail.com',
      password_hash: hash(pw), role: 'employee',
      department: 'Marketing', manager_id: mgr2Id,
      phone: '9000000009', assigned_block: 'District 1', assigned_district: 'South Tripura',
      email_verified: true,
    },
  ];

  let created = 0, updated = 0;

  for (const u of users) {
    const existing = await User.findOne({ emp_id: u.emp_id });
    if (existing) {
      // Update everything EXCEPT password (don't overwrite if user changed it)
      await User.findByIdAndUpdate(existing._id, {
        $set: {
          name: u.name, email: u.email, role: u.role,
          department: u.department, manager_id: u.manager_id,
          phone: u.phone, assigned_block: u.assigned_block,
          assigned_district: u.assigned_district,
          is_active: 1, email_verified: true,
        }
      });
      console.log(`  ♻️  Updated: ${u.emp_id} — ${u.name} (${u.role})`);
      updated++;
    } else {
      await User.create(u);
      console.log(`  ✅ Created: ${u.emp_id} — ${u.name} (${u.role})`);
      created++;
    }
  }

  console.log(`\n✅ Seed complete! Created: ${created}, Updated: ${updated}`);
  console.log('\n📋 Login Credentials (password for NEW users: R@m%Brp@26)');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  ROLE          EMP_ID    EMAIL');
  console.log('  ─────────────────────────────────────────────────────────');
  users.forEach(u => {
    console.log(`  ${u.role.padEnd(14)} ${u.emp_id.padEnd(9)} ${u.email}`);
  });
  console.log('─────────────────────────────────────────────────────────────');

  process.exit(0);
};

seed().catch(err => { console.error('❌ Seed failed:', err); process.exit(1); });
