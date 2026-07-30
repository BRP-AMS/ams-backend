const express = require('express');
const router  = express.Router();
const { CustomDepartment } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const BASE_DEPARTMENTS = [
  'Field Operation',
  'Head Office Operations',
  'Industries & Commerce',
  'Kamalpur Nagar Panchayat',
  'Kalyanpur Block',
  'Kadamtala Block',
  'Boxanagar Block',
  'Santirbazar Municipal Council',
  'Kumarghat Municipal Council',
];

const seedIfEmpty = async () => {
  const count = await CustomDepartment.countDocuments();
  if (count > 0) return;
  await CustomDepartment.insertMany(
    BASE_DEPARTMENTS.map(name => ({ name, added_by: null })),
    { ordered: false }
  ).catch(() => {});
};

// GET /api/departments — all departments, sorted A-Z
router.get('/', async (req, res) => {
  try {
    await seedIfEmpty();
    const all = await CustomDepartment.find({}).sort({ name: 1 }).lean();
    res.json({ success: true, departments: all.map(d => ({ _id: d._id, name: d.name, isCustom: !!d.added_by })) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/departments — add new department
router.post('/', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    const exists = await CustomDepartment.findOne({ name });
    if (exists) return res.status(409).json({ success: false, message: 'Department already exists' });
    const dept = await CustomDepartment.create({ name, added_by: req.user._id || req.user.id });
    res.status(201).json({ success: true, department: { _id: dept._id, name: dept.name, isCustom: true } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'Department already exists' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/departments/:id — rename
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    const dept = await CustomDepartment.findByIdAndUpdate(req.params.id, { name }, { new: true });
    if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });
    res.json({ success: true, department: { _id: dept._id, name: dept.name, isCustom: !!dept.added_by } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/departments/:id — remove
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const dept = await CustomDepartment.findByIdAndDelete(req.params.id);
    if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
