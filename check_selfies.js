const { User, AttendanceRecord } = require('./src/models/database');
require('dotenv').config();

async function check() {
    try {
        const user = await User.findOne({ name: /rajesh/i });
        if (!user) {
            console.log('User Rajesh Kumar not found');
            process.exit(0);
        }
        console.log(`Found User: ${user.name} (${user.emp_id})`);
        
        const records = await AttendanceRecord.find({ emp_id: user._id });
        console.log(`Found ${records.length} records for ${user.name}.`);
        
        records.forEach(r => {
            console.log(`Date: ${r.date} | Status: ${r.status}`);
            console.log(`  Check-in Selfie:  ${r.selfie_path}`);
            console.log(`  Check-out Selfie: ${r.checkout_selfie_path}`);
        });
    } catch (err) {
        console.error(err);
    }
    process.exit(0);
}

check();
