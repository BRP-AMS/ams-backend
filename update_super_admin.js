require('dotenv').config();
const bcrypt = require('bcryptjs');
const { User, connectionPromise } = require('./src/models/database');

const update = async () => {
  await connectionPromise;
  console.log('--- Updating Super Admin Credentials ---');
  
  const user = await User.findOne({ emp_id: 'SADM001' });
  if (!user) {
    console.error('SADM001 not found! Creating new super_admin account...');
    const { v4: uuidv4 } = require('uuid');
    await User.create({
      _id: uuidv4(),
      emp_id: 'SADM001',
      name: 'Super Admin',
      email: 'ajay.s@raminfo.com',
      password_hash: bcrypt.hashSync('R@m%Brp@26', 12),
      role: 'super_admin',
      department: 'Executive',
      is_active: 1,
      email_verified: true,
      phone_verified: true
    });
  } else {
    await User.findByIdAndUpdate(user._id, {
      $set: {
        email: 'ajay.s@raminfo.com',
        password_hash: bcrypt.hashSync('R@m%Brp@26', 12)
      }
    });
    console.log('SADM001 updated successfully to: ajay.s@raminfo.com / R@m%Brp@26');
  }

  process.exit(0);
};

update().catch(err => { console.error(err); process.exit(1); });
