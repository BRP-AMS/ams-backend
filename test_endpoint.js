const axios = require('axios');

const API_BASE = "http://localhost:10000/api";

const test = async () => {
  try {
    // Login as Super Admin
    console.log('Logging in...');
    const loginRes = await axios.post(`${API_BASE}/auth/login`, {
      email: 'superadmin@company.com',
      password: 'R@m%Brp@26'
    });
    const token = loginRes.data.token;
    console.log('Login successful. Token:', token.substring(0, 10) + '...');

    // Call GET /activity-schedule
    console.log('Fetching schedules...');
    const schedRes = await axios.get(`${API_BASE}/activity-schedule`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Schedules fetched successfully:', schedRes.data.data.length);
  } catch (err) {
    console.error('Test failed!');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error:', err.message);
    }
  }
};

test();
