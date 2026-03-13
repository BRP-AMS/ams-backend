require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, AttendanceRecord, Notification, AuditLog, Activity, ActivityDocument, connectionPromise } = require('./src/models/database');

const seed = async () => {
  // Wait for MongoDB Atlas connection established in database.js
  await connectionPromise;

  console.log('🌱 Seeding database...');

  // Clear existing data
  await Promise.all([
    AuditLog.deleteMany({}),
    Notification.deleteMany({}),
    AttendanceRecord.deleteMany({}),
    User.deleteMany({}),
  ]);

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  // ── Create users ──────────────────────────────────────────────────────
  const adminId = uuidv4();
  const mgr1Id  = uuidv4();
  const mgr2Id  = uuidv4();
  const emp1Id  = uuidv4();
  const emp2Id  = uuidv4();
  const emp3Id  = uuidv4();
  const emp4Id  = uuidv4();
  const superAdminId = uuidv4();
  const hrId = uuidv4();

  await User.insertMany([
    { _id: adminId, emp_id: 'ADM001', name: 'Rajesh Kumar', email: 'admin@brp.com',  password_hash: hash('Admin@123'),    role: 'admin',    department: 'Administration', manager_id: null,   phone: '9876543210' },
    { _id: mgr1Id,  emp_id: 'MGR001', name: 'Priya Sharma', email: 'priya@brp.com',  password_hash: hash('Manager@123'),  role: 'manager',  department: 'Engineering',    manager_id: adminId,phone: '9876543211' },
    { _id: mgr2Id,  emp_id: 'MGR002', name: 'Vikram Nair',  email: 'vikram@brp.com', password_hash: hash('Manager@123'),  role: 'manager',  department: 'Sales',          manager_id: adminId,phone: '9876543212' },
    { _id: emp1Id,  emp_id: 'EMP001', name: 'John Doe',     email: 'john@brp.com',   password_hash: hash('Employee@123'), role: 'employee', department: 'Engineering',    manager_id: mgr1Id, phone: '9876543213' },
    { _id: emp2Id,  emp_id: 'EMP002', name: 'Sarah Lee',    email: 'sarah@brp.com',  password_hash: hash('Employee@123'), role: 'employee', department: 'Engineering',    manager_id: mgr1Id, phone: '9876543214' },
    { _id: emp3Id,  emp_id: 'EMP003', name: 'David Kim',    email: 'david@brp.com',  password_hash: hash('Employee@123'), role: 'employee', department: 'Sales',          manager_id: mgr2Id, phone: '9876543215' },
    { _id: emp4Id,  emp_id: 'EMP004', name: 'Meera Patel',  email: 'meera@brp.com',  password_hash: hash('Employee@123'), role: 'employee', department: 'Sales',          manager_id: mgr2Id, phone: '9876543216' },
    { _id: superAdminId, emp_id: 'SADM01', name: 'Super Admin', email: 'superadmin@brp.com', password_hash: hash('Super@123'), role: 'super_admin', department: 'Administration', manager_id: null, phone: '9876543217' },
    { _id: hrId,    emp_id: 'HR001',  name: 'HR Manager',   email: 'hr@raminfo.com', password_hash: hash('Hr@12345'),     role: 'hr',       department: 'HR',             manager_id: adminId, phone: '9876543218' },
  ]);

  // ── Create attendance records ─────────────────────────────────────────
  await AttendanceRecord.insertMany([
    // John Doe - emp1
    { _id: uuidv4(), emp_id: emp1Id, date: '2024-10-10', duty_type: 'On Duty',     sector: 'MSME', description: 'Client meeting at ABC Corp, discussed Q4 requirements',    status: 'Rejected', latitude: 12.9716, longitude: 77.5946, location_address: 'Whitefield, Bengaluru',       checkin_time: '09:00', checkout_time: '17:30', checkin_lat: 12.9716, checkin_lng: 77.5946, checkout_lat: 12.9850, checkout_lng: 77.6101, manager_id: mgr1Id, manager_remark: 'Incorrect location data submitted',  submitted_at: new Date('2024-10-10T17:30:00'), actioned_by: mgr1Id, actioned_at: new Date('2024-10-11T09:00:00') },
    { _id: uuidv4(), emp_id: emp1Id, date: '2024-10-11', duty_type: 'Office Duty', sector: null,   description: '',                                                           status: 'Approved', latitude: 12.9716, longitude: 77.5946, location_address: 'BRP Office, Bengaluru',        checkin_time: '09:15', checkout_time: '18:00', checkin_lat: 12.9716, checkin_lng: 77.5946, checkout_lat: 12.9716, checkout_lng: 77.5946, manager_id: mgr1Id, manager_remark: '',                                     submitted_at: new Date('2024-10-11T18:00:00'), actioned_by: mgr1Id, actioned_at: new Date('2024-10-12T08:30:00') },
    { _id: uuidv4(), emp_id: emp1Id, date: '2024-10-12', duty_type: 'On Duty',     sector: 'Govt', description: 'MSME Development Office visit for compliance documentation', status: 'Pending',  latitude: 12.9352, longitude: 77.6245, location_address: 'MSME Office, Bengaluru',        checkin_time: '08:45', checkout_time: '16:30', checkin_lat: 12.9352, checkin_lng: 77.6245, checkout_lat: 12.9352, checkout_lng: 77.6245, manager_id: mgr1Id, manager_remark: '',                                     submitted_at: new Date('2024-10-12T16:30:00'), actioned_by: null,   actioned_at: null },
    { _id: uuidv4(), emp_id: emp1Id, date: '2024-10-14', duty_type: 'Office Duty', sector: null,   description: '',                                                           status: 'Approved', latitude: 12.9716, longitude: 77.5946, location_address: 'BRP Office, Bengaluru',        checkin_time: '09:05', checkout_time: '18:15', checkin_lat: 12.9716, checkin_lng: 77.5946, checkout_lat: 12.9716, checkout_lng: 77.5946, manager_id: mgr1Id, manager_remark: '',                                     submitted_at: new Date('2024-10-14T18:15:00'), actioned_by: mgr1Id, actioned_at: new Date('2024-10-15T08:00:00') },
    { _id: uuidv4(), emp_id: emp1Id, date: '2024-10-15', duty_type: 'On Duty',     sector: 'Training', description: 'Attended React advanced training workshop at Indiranagar', status: 'Pending', latitude: 12.9784, longitude: 77.6408, location_address: 'Indiranagar, Bengaluru',    checkin_time: '09:30', checkout_time: '17:00', checkin_lat: 12.9784, checkin_lng: 77.6408, checkout_lat: 12.9784, checkout_lng: 77.6408, manager_id: mgr1Id, manager_remark: '',                                     submitted_at: new Date('2024-10-15T17:00:00'), actioned_by: null,   actioned_at: null },
    // Sarah Lee - emp2
    { _id: uuidv4(), emp_id: emp2Id, date: '2024-10-12', duty_type: 'On Duty',     sector: 'Govt', description: 'Government liaison meeting for regulatory approvals',        status: 'Pending',  latitude: 12.9719, longitude: 77.6412, location_address: 'Koramangala, Bengaluru',       checkin_time: '08:45', checkout_time: '16:30', checkin_lat: 12.9719, checkin_lng: 77.6412, checkout_lat: 12.9719, checkout_lng: 77.6412, manager_id: mgr1Id, manager_remark: '',                                     submitted_at: new Date('2024-10-12T16:30:00'), actioned_by: null,   actioned_at: null },
    { _id: uuidv4(), emp_id: emp2Id, date: '2024-10-13', duty_type: 'Office Duty', sector: null,   description: '',                                                           status: 'Pending',  latitude: 12.9716, longitude: 77.5946, location_address: 'BRP Office, Bengaluru',        checkin_time: '09:00', checkout_time: '17:00', checkin_lat: 12.9716, checkin_lng: 77.5946, checkout_lat: 12.9716, checkout_lng: 77.5946, manager_id: mgr1Id, manager_remark: '',                                     submitted_at: new Date('2024-10-13T17:00:00'), actioned_by: null,   actioned_at: null },
    { _id: uuidv4(), emp_id: emp2Id, date: '2024-10-14', duty_type: 'On Duty',     sector: 'MSME', description: 'Visited 3 MSME clients in Electronic City for onboarding',  status: 'Approved', latitude: 12.8399, longitude: 77.6770, location_address: 'Electronic City, Bengaluru',   checkin_time: '08:30', checkout_time: '18:00', checkin_lat: 12.8399, checkin_lng: 77.6770, checkout_lat: 12.8399, checkout_lng: 77.6770, manager_id: mgr1Id, manager_remark: 'Good work on client visits',          submitted_at: new Date('2024-10-14T18:00:00'), actioned_by: mgr1Id, actioned_at: new Date('2024-10-15T09:00:00') },
    // David Kim - emp3
    { _id: uuidv4(), emp_id: emp3Id, date: '2024-10-14', duty_type: 'On Duty',     sector: 'MSME', description: 'Sales presentation to potential MSME client cluster',        status: 'Approved', latitude: 13.0359, longitude: 77.5970, location_address: 'Hebbal, Bengaluru',           checkin_time: '09:00', checkout_time: '17:45', checkin_lat: 13.0359, checkin_lng: 77.5970, checkout_lat: 13.0359, checkout_lng: 77.5970, manager_id: mgr2Id, manager_remark: '',                                     submitted_at: new Date('2024-10-14T17:45:00'), actioned_by: mgr2Id, actioned_at: new Date('2024-10-15T08:00:00') },
    { _id: uuidv4(), emp_id: emp3Id, date: '2024-10-15', duty_type: 'Office Duty', sector: null,   description: '',                                                           status: 'Pending',  latitude: 12.9716, longitude: 77.5946, location_address: 'BRP Office, Bengaluru',        checkin_time: '09:10', checkout_time: '17:50', checkin_lat: 12.9716, checkin_lng: 77.5946, checkout_lat: 12.9716, checkout_lng: 77.5946, manager_id: mgr2Id, manager_remark: '',                                     submitted_at: new Date('2024-10-15T17:50:00'), actioned_by: null,   actioned_at: null },
    // Meera Patel - emp4
    { _id: uuidv4(), emp_id: emp4Id, date: '2024-10-15', duty_type: 'On Duty',     sector: 'Govt', description: 'Government tender submission and follow-up',                  status: 'Rejected', latitude: 12.9767, longitude: 77.5713, location_address: 'Vidhana Soudha, Bengaluru',   checkin_time: '10:00', checkout_time: '16:00', checkin_lat: 12.9767, checkin_lng: 77.5713, checkout_lat: 12.9767, checkout_lng: 77.5713, manager_id: mgr2Id, manager_remark: 'Supporting documents not attached',    submitted_at: new Date('2024-10-15T16:00:00'), actioned_by: mgr2Id, actioned_at: new Date('2024-10-16T09:30:00') },
  ]);

  // ── Create notifications ──────────────────────────────────────────────
  await Notification.insertMany([
    { _id: uuidv4(), user_id: emp1Id,  title: 'Record Rejected',   message: 'Your Oct 10 attendance was rejected: Incorrect location data', type: 'error'   },
    { _id: uuidv4(), user_id: emp1Id,  title: 'Record Approved',   message: 'Your Oct 11 attendance has been approved',                      type: 'success' },
    { _id: uuidv4(), user_id: mgr1Id,  title: 'Pending Approvals', message: '3 attendance records pending your review',                      type: 'warning' },
    { _id: uuidv4(), user_id: adminId, title: 'System Summary',    message: '2 records rejected by managers - override available',           type: 'info'    },
  ]);

  console.log('✅ Database seeded successfully!');
  console.log('\n📋 Demo Credentials:');
  console.log('  Admin:    admin@brp.com    / Admin@123');
  console.log('  Manager1: priya@brp.com    / Manager@123');
  console.log('  Manager2: vikram@brp.com   / Manager@123');
  console.log('  Employee: john@brp.com     / Employee@123');
  console.log('  Employee: sarah@brp.com    / Employee@123');
  console.log('  HR:       hr@raminfo.com   / Hr@12345');
  console.log('  SuperAdm: superadmin@brp.com / Super@123');

  process.exit(0);
};

seed().catch(err => { console.error(err); process.exit(1); });
