require('dotenv').config();
const bcrypt = require('bcryptjs');
const { User, connectionPromise } = require('./src/models/database');

const test = async () => {
  await connectionPromise;
  console.log('--- Testing Account Access ---');
  
  const user = await User.findOne({ emp_id: 'SADM001' }).lean();
  if (!user) {
    console.error('SADM001 not found!');
    process.exit(1);
  }

  const testPass = 'Pass@123';
  const isMatch = bcrypt.compareSync(testPass, user.password_hash);
  console.log(`User: ${user.emp_id} | Email: ${user.email}`);
  console.log(`Password "${testPass}" matches: ${isMatch}`);

  if (!isMatch) {
    console.log('RE-HASHING for SADM001 to ensure Pass@123 is set...');
    await User.findByIdAndUpdate(user._id, {
      $set: { password_hash: bcrypt.hashSync(testPass, 12) }
    });
    console.log('Password re-hashed successfully.');
  }

  process.exit(0);
};

test().catch(err => { console.error(err); process.exit(1); });
