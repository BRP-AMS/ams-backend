require('dotenv').config();
const { User, AuditLog, connectionPromise } = require('./src/models/database');

const verify = async () => {
  await connectionPromise;
  console.log('--- Database Verification ---');
  
  const users = await User.find({}).select('emp_id email role is_active').lean();
  console.log(`Total Users: ${users.length}`);
  users.forEach(u => console.log(` - [${u.emp_id}] ${u.email} (${u.role}) Active: ${u.is_active}`));

  const recentLogins = await AuditLog.find({ action: 'LOGIN' }).sort({ created_at: -1 }).limit(5).lean();
  console.log('\n--- Recent Logins ---');
  if (recentLogins.length === 0) console.log('No recent logins found.');
  for (const log of recentLogins) {
    const user = await User.findById(log.user_id).select('emp_id email').lean();
    console.log(`[${log.created_at.toISOString()}] User: ${user?.emp_id || 'Unknown'} (${user?.email || 'N/A'}) IP: ${log.ip_address}`);
  }

  process.exit(0);
};

verify().catch(err => { console.error(err); process.exit(1); });
