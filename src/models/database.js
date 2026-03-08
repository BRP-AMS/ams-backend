const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kshreyareddy1323_db_user:kshreyareddy1323_db_user@cluster0.o9v3njy.mongodb.net/brp-attendance?retryWrites=true&w=majority';
// ── Schemas ───────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  _id:           { type: String },
  emp_id:        { type: String, unique: true, required: true },
  name:          { type: String, required: true },
  email:         { type: String, unique: true, required: true },
  password_hash: { type: String, required: true },
  role:          { type: String, enum: ['employee', 'manager', 'admin'], required: true },
  department:    { type: String, required: true },
  manager_id:       { type: String, ref: 'User', default: null },
  phone:            { type: String, default: null },
  is_active:        { type: Number, default: 1 },
  assigned_block:    { type: String, default: null },
  assigned_district: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userSchema.index({ manager_id: 1 });
userSchema.index({ role: 1 });
userSchema.index({ is_active: 1 });

const attendanceRecordSchema = new mongoose.Schema({
  _id:                  { type: String },
  emp_id:               { type: String, ref: 'User', required: true },
  date:                 { type: String, required: true },
  duty_type:            { type: String, enum: ['Office Duty', 'On Duty'], required: true },
  sector:               { type: String, default: null },
  description:          { type: String, default: null },
  status:               { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Draft' },
  selfie_path:          { type: String, default: null },
  checkout_selfie_path: { type: String, default: null },
  latitude:             { type: Number, default: null },
  longitude:            { type: Number, default: null },
  location_address:     { type: String, default: null },
  checkin_time:         { type: String, default: null },
  checkout_time:        { type: String, default: null },
  checkin_lat:          { type: Number, default: null },
  checkin_lng:          { type: Number, default: null },
  checkout_lat:         { type: Number, default: null },
  checkout_lng:         { type: Number, default: null },
  manager_id:           { type: String, ref: 'User', default: null },
  manager_remark:       { type: String, default: null },
  admin_remark:         { type: String, default: null },
  actioned_by:          { type: String, ref: 'User', default: null },
  actioned_at:          { type: Date, default: null },
  submitted_at:         { type: Date, default: null },
  worked_hours:         { type: Number, default: null },
  is_auto_checkout:     { type: Boolean, default: false },
  checkout_remarks:     { type: String, default: null },
  leave_type:           { type: String, enum: ['Half Day', 'Emergency Leave', null], default: null },
  leave_reason:         { type: String, default: null },
  leave_status:         { type: String, enum: ['Pending', 'Approved', 'Rejected', null], default: null },
  reapply_reason:       { type: String, default: null },
  reapply_docs:         { type: [String], default: [] },
  reapplied_at:         { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// Unique constraint equivalent to SQLite UNIQUE(emp_id, date)
attendanceRecordSchema.index({ emp_id: 1, date: 1 }, { unique: true });
attendanceRecordSchema.index({ date: 1 });
attendanceRecordSchema.index({ status: 1 });
attendanceRecordSchema.index({ manager_id: 1 });
attendanceRecordSchema.index({ manager_id: 1, status: 1 });
attendanceRecordSchema.index({ date: 1, status: 1 });

const notificationSchema = new mongoose.Schema({
  _id:               { type: String },
  user_id:           { type: String, ref: 'User', required: true },
  title:             { type: String, required: true },
  message:           { type: String, required: true },
  type:              { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
  is_read:           { type: Number, default: 0 },
  related_record_id: { type: String, ref: 'AttendanceRecord', default: null },
  link:              { type: String, default: null }, // frontend navigation path on click
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

notificationSchema.index({ user_id: 1 });
notificationSchema.index({ user_id: 1, is_read: 1 });

const auditLogSchema = new mongoose.Schema({
  _id:         { type: String },
  user_id:     { type: String, ref: 'User', required: true },
  action:      { type: String, required: true },
  entity_type: { type: String, default: null },
  entity_id:   { type: String, default: null },
  old_value:   { type: String, default: null },
  new_value:   { type: String, default: null },
  ip_address:  { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

auditLogSchema.index({ entity_type: 1, entity_id: 1 });
auditLogSchema.index({ user_id: 1 });
auditLogSchema.index({ created_at: 1 });

// Uses token_hash as _id for O(1) lookup and insert-or-ignore behaviour
const revokedTokenSchema = new mongoose.Schema({
  _id:        { type: String }, // token_hash stored as _id
  revoked_at: { type: Date, default: Date.now },
});

const activitySchema = new mongoose.Schema({
  _id:              { type: String },
  user_id:          { type: String, ref: 'User', required: true },
  msme_name:        { type: String, required: true },
  udyam_number:     { type: String, required: true },
  sector:           { type: String, enum: ['Manufacturing', 'Services', 'Trade', 'Agriculture', 'Other'], required: true },
  support_type:     { type: String, enum: ['Awareness', 'Marketing Linkage', 'Loan Facilitation', 'Training/Workshop', 'Advisory/Other'], required: true },
  block_name:       { type: String, required: true },
  latitude:         { type: Number, default: null },
  longitude:        { type: Number, default: null },
  location_address: { type: String, default: null },
  activity_date:    { type: String, required: true },
  remarks:          { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

activitySchema.index({ user_id: 1 });
activitySchema.index({ activity_date: 1 });
activitySchema.index({ block_name: 1 });
activitySchema.index({ sector: 1 });
activitySchema.index({ activity_date: 1, block_name: 1 });

const activityDocumentSchema = new mongoose.Schema({
  _id:         { type: String },
  activity_id: { type: String, ref: 'Activity', required: true },
  file_path:   { type: String, required: true },
  file_name:   { type: String, required: true },
  file_type:   { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

activityDocumentSchema.index({ activity_id: 1 });

// ── Models ────────────────────────────────────────────────────────────────

const User             = mongoose.model('User',             userSchema);
const AttendanceRecord = mongoose.model('AttendanceRecord', attendanceRecordSchema);
const Notification     = mongoose.model('Notification',     notificationSchema);
const AuditLog         = mongoose.model('AuditLog',         auditLogSchema);
const RevokedToken     = mongoose.model('RevokedToken',     revokedTokenSchema);
const Activity         = mongoose.model('Activity',         activitySchema);
const ActivityDocument = mongoose.model('ActivityDocument', activityDocumentSchema);

// ── Default admin seed (only when DB is empty) ────────────────────────────

const initDefaultAdmin = async () => {
  const count = await User.countDocuments();
  if (count === 0) {
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    await User.create({
      _id:           uuidv4(),
      emp_id:        'ADM001',
      name:          'Admin',
      email:         'admin@brp.com',
      password_hash: bcrypt.hashSync('Admin@123', 10),
      role:          'admin',
      department:    'Administration',
      phone:         '0000000000',
    });
    console.log('✅ Default admin created: admin@brp.com / Admin@123');
  }
};

// ── Connect ───────────────────────────────────────────────────────────────

const connectionPromise = mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB Atlas connected');
    await initDefaultAdmin();
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

module.exports = {
  User,
  AttendanceRecord,
  Notification,
  AuditLog,
  RevokedToken,
  Activity,
  ActivityDocument,
  connectionPromise,
};
