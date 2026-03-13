require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, AttendanceRecord, Notification, AuditLog, Activity, ActivityDocument, connectionPromise } = require('./src/models/database');

const seed = async () => {

  await connectionPromise;

  console.log('🌱 Seeding database...');

  await Promise.all([
    AuditLog.deleteMany({}),
    Notification.deleteMany({}),
    AttendanceRecord.deleteMany({}),
    User.deleteMany({}),
  ]);

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  // ─── Create IDs ───────────────────────────────

  const superAdminId = uuidv4();
  const adminId = uuidv4();
  const hrId = uuidv4();

  const mgr1Id = uuidv4();
  const mgr2Id = uuidv4();

  const emp1Id = uuidv4();
  const emp2Id = uuidv4();
  const emp3Id = uuidv4();
  const emp4Id = uuidv4();


  // ─── USERS ────────────────────────────────────

  await User.insertMany([

    // SUPER ADMIN
    {
      _id: superAdminId,
      emp_id: 'SUP001',
      name: 'Super Admin',
      email: 'superadmin@brp.com',
      password_hash: hash('SuperAdmin@123'),
      role: 'super_admin',
      department: 'Administration',
      manager_id: null,
      phone: '9000000001'
    },

    // ADMIN
    {
      _id: adminId,
      emp_id: 'ADM001',
      name: 'Rajesh Kumar',
      email: 'admin@brp.com',
      password_hash: hash('Admin@123'),
      role: 'admin',
      department: 'Administration',
      manager_id: superAdminId,
      phone: '9000000002'
    },

    // HR
    {
      _id: hrId,
      emp_id: 'HR001',
      name: 'Anita HR',
      email: 'hr@brp.com',
      password_hash: hash('HR@123'),
      role: 'hr',
      department: 'Human Resources',
      manager_id: adminId,
      phone: '9000000003'
    },

    // MANAGERS
    {
      _id: mgr1Id,
      emp_id: 'MGR001',
      name: 'Priya Sharma',
      email: 'priya@brp.com',
      password_hash: hash('Manager@123'),
      role: 'manager',
      department: 'Engineering',
      manager_id: hrId,
      phone: '9000000004'
    },

    {
      _id: mgr2Id,
      emp_id: 'MGR002',
      name: 'Vikram Nair',
      email: 'vikram@brp.com',
      password_hash: hash('Manager@123'),
      role: 'manager',
      department: 'Sales',
      manager_id: hrId,
      phone: '9000000005'
    },

    // EMPLOYEES
    {
      _id: emp1Id,
      emp_id: 'EMP001',
      name: 'John Doe',
      email: 'john@brp.com',
      password_hash: hash('Employee@123'),
      role: 'employee',
      department: 'Engineering',
      manager_id: mgr1Id,
      phone: '9000000006'
    },

    {
      _id: emp2Id,
      emp_id: 'EMP002',
      name: 'Sarah Lee',
      email: 'sarah@brp.com',
      password_hash: hash('Employee@123'),
      role: 'employee',
      department: 'Engineering',
      manager_id: mgr1Id,
      phone: '9000000007'
    },

    {
      _id: emp3Id,
      emp_id: 'EMP003',
      name: 'David Kim',
      email: 'david@brp.com',
      password_hash: hash('Employee@123'),
      role: 'employee',
      department: 'Sales',
      manager_id: mgr2Id,
      phone: '9000000008'
    },

    {
      _id: emp4Id,
      emp_id: 'EMP004',
      name: 'Meera Patel',
      email: 'meera@brp.com',
      password_hash: hash('Employee@123'),
      role: 'employee',
      department: 'Sales',
      manager_id: mgr2Id,
      phone: '9000000009'
    }

  ]);


  // ─── ATTENDANCE ───────────────────────────────

  await AttendanceRecord.insertMany([

    {
      _id: uuidv4(),
      emp_id: emp1Id,
      date: '2024-10-10',
      duty_type: 'On Duty',
      sector: 'MSME',
      description: 'Client meeting',
      status: 'Pending',
      latitude: 12.9716,
      longitude: 77.5946,
      location_address: 'Whitefield',
      checkin_time: '09:00',
      checkout_time: '17:30',
      manager_id: mgr1Id,
      manager_remark: '',
      submitted_at: new Date()
    },

    {
      _id: uuidv4(),
      emp_id: emp2Id,
      date: '2024-10-11',
      duty_type: 'Office Duty',
      sector: null,
      description: '',
      status: 'Approved',
      latitude: 12.9716,
      longitude: 77.5946,
      location_address: 'BRP Office',
      checkin_time: '09:10',
      checkout_time: '18:00',
      manager_id: mgr1Id,
      manager_remark: '',
      submitted_at: new Date()
    }

  ]);


  // ─── NOTIFICATIONS ───────────────────────────

  await Notification.insertMany([

    {
      _id: uuidv4(),
      user_id: emp1Id,
      title: 'Attendance Pending',
      message: 'Your attendance record is pending approval',
      type: 'warning'
    },

    {
      _id: uuidv4(),
      user_id: mgr1Id,
      title: 'New Attendance Request',
      message: 'You have new attendance records to approve',
      type: 'info'
    },

    {
      _id: uuidv4(),
      user_id: hrId,
      title: 'HR Notification',
      message: 'Employee onboarding review pending',
      type: 'info'
    }

  ]);


  console.log('✅ Database seeded successfully!\n');

  console.log('📋 Demo Credentials');

  console.log('Super Admin : superadmin@brp.com / SuperAdmin@123');
  console.log('Admin       : admin@brp.com / Admin@123');
  console.log('HR          : hr@brp.com / HR@123');
  console.log('Manager     : priya@brp.com / Manager@123');
  console.log('Employee    : john@brp.com / Employee@123');


  process.exit(0);

};

seed().catch(err => {
  console.error(err);
  process.exit(1);
});