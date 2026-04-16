const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, AttendanceRecord, Notification, AuditLog, Activity, ActivityDocument, connectionPromise } = require('./src/models/database');

const seed = async () => {
  await connectionPromise;
  console.log('🌱 Seeding database...');

  // Clear existing data
  await Promise.all([
    AuditLog.deleteMany({}),
    Notification.deleteMany({}),
    AttendanceRecord.deleteMany({}),
    User.deleteMany({}),
  ]);

  const hash = (pw) => bcrypt.hashSync(pw, 12);
  // Password must be supplied via SEED_ADMIN_PASSWORD env var — never hardcode.
  const pw = process.env.SEED_ADMIN_PASSWORD;
  if (!pw || pw.length < 12) {
    console.error('FATAL: SEED_ADMIN_PASSWORD env var is required (min 12 chars).');
    console.error('Example: SEED_ADMIN_PASSWORD="YourStrongPassHere!23" node seed.js');
    process.exit(1);
  }

  // ── IDs ──────────────────────────────────────────────────────────────
  const superAdminId = uuidv4();
  const adminId      = uuidv4();
 

  // ── Users ─────────────────────────────────────────────────────────────
    // ── Users ─────────────────────────────────────────────────────────────
  await User.insertMany([
    // Super Admin
    { _id: superAdminId, emp_id: 'SADM001', name: 'Super Admin', email: 'ajay.s@raminfo.com', password_hash: hash(pw), role: 'super_admin', department: 'Administration', manager_id: null, phone: '9000000001' },
    
    // Admin (Make sure there is no stray ' above this line)
    { _id: adminId, emp_id: 'ADM001', name: 'Admin User', email: 'ajay.rges@gmail.com', password_hash: hash(pw), role: 'admin', department: 'Administration', manager_id: null, phone: '9000000002' },
  ]);

 

  

  console.log('Database seeded successfully.');
  console.log('-------------------------------------------------');
  console.log('  Super Admin: ajay.s@raminfo.com  (SADM001)');
  console.log('  Admin:        ajay.rges@gmail.com      (ADM001)');
  console.log('  Password:    [value of SEED_ADMIN_PASSWORD env var]');
  console.log('-------------------------------------------------');

  process.exit(0);
};

seed().catch(err => { console.error(err); process.exit(1); });