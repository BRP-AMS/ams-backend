const express = require('express');
const router  = express.Router();
const { CustomBlock } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// Base list used ONLY for seeding on first run
const BASE_DISTRICT_BLOCKS = {
  'Dhalai':       ['Ambassa','Chawmanu','Durgachowmuhani','Dumburnagar','Ganganagar','Manu','Raishyabari','Salema','Ambassa Municipal Council','Kamalpur Nagar Panchayat'],
  'Gomati':       ['Amarpur','Kakraban','Karbook','Killa','Matabari','Ompi','Silachhari','Tepania','Amarpur Nagar Panchayat','Udaipur Municipal Council'],
  'Hyderabad':    ['Madhapur'],
  'Khowai':       ['Kalyanpur','Khowai','Mungiakami','Padmabil','Teliamura','Tulashikhar','Khowai Municipal Council','Teliamura Municipal Council'],
  'North Tripura':['Damcherra','Dasda','Jampui Hills','Jubrajnagar','Kadamtala','Kalacherra','Laljuri','Panisagar','Dharmanagar Municipal Council','Panisagar Nagar Panchayat'],
  'Sipahijala':   ['Bishalgarh','Boxanagar','Charilam','Jampuijala','Kathalia','Mohanbhog','Nalchar','Bishalgarh Municipal Council','Melaghar Municipal Council','Sonamura Nagar Panchayat'],
  'South Tripura':['Bharat Chandra Nagar','Bokafa','Hrishyamukh','Jolaibari','Poangbari','Rajnagar','Rupaichari','Satchand','Belonia Municipal Council','Sabroom Nagar Panchayat','Santirbazar Municipal Council'],
  'Unakoti':      ['Chandipur','Gournagar','Kumarghat','Pecharthal','Kailasahar Municipal Council','Kumarghat Municipal Council'],
  'West Tripura': ['Bamutia','Belbari','DIC West','Dukli','Hezamara','Jirania','Lefunga','Mandai','Mohanpur','Old Agartala','Agartala Municipal Council (Central Zone)','Agartala Municipal Council (East Zone)','Agartala Municipal Council (North Zone)','Agartala Municipal Council (South Zone)','Jirania Nagar Panchayat','Mohanpur Municipal Council','Ranirbazar Municipal Council'],
};

const seedIfEmpty = async () => {
  const count = await CustomBlock.countDocuments();
  if (count > 0) return;
  const docs = [];
  for (const [district, blocks] of Object.entries(BASE_DISTRICT_BLOCKS)) {
    for (const b of blocks) {
      docs.push({ district, block_name: b, added_by: null });
    }
  }
  await CustomBlock.insertMany(docs, { ordered: false }).catch(() => {});
};

// GET /api/blocks — all blocks from DB (seeded on first call), grouped by district, sorted A-Z
router.get('/', async (req, res) => {
  try {
    await seedIfEmpty();
    const all = await CustomBlock.find({}).lean();
    const result = {};
    for (const b of all) {
      if (!result[b.district]) result[b.district] = [];
      result[b.district].push({
        _id: b._id, name: b.block_name, isCustom: !!b.added_by,
        latitude: b.latitude ?? null, longitude: b.longitude ?? null,
      });
    }
    for (const d of Object.keys(result)) {
      result[d].sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json({ success: true, blocks: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/blocks — add a new block (admin / super_admin)
router.post('/', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { district, block_name, latitude, longitude } = req.body;
    if (!district || !block_name?.trim()) {
      return res.status(400).json({ success: false, message: 'district and block_name required' });
    }
    const trimmed = block_name.trim();
    const exists = await CustomBlock.findOne({ district, block_name: trimmed });
    if (exists) return res.status(409).json({ success: false, message: 'Block already exists in this district' });
    const lat = latitude !== undefined && latitude !== '' ? parseFloat(latitude) : null;
    const lng = longitude !== undefined && longitude !== '' ? parseFloat(longitude) : null;
    const block = await CustomBlock.create({
      district, block_name: trimmed, added_by: req.user._id || req.user.id,
      latitude: Number.isFinite(lat) ? lat : null, longitude: Number.isFinite(lng) ? lng : null,
    });
    res.status(201).json({ success: true, block: { _id: block._id, name: block.block_name, district: block.district, isCustom: true, latitude: block.latitude, longitude: block.longitude } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'Block already exists' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/blocks/rename-district — rename all blocks under a district (must be before /:id)
router.put('/rename-district', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { oldDistrict, newDistrict } = req.body;
    if (!oldDistrict?.trim() || !newDistrict?.trim()) {
      return res.status(400).json({ success: false, message: 'oldDistrict and newDistrict required' });
    }
    const trimmed = newDistrict.trim();
    const conflict = await CustomBlock.findOne({ district: trimmed });
    if (conflict && conflict.district !== oldDistrict.trim()) {
      return res.status(409).json({ success: false, message: 'A district with that name already exists' });
    }
    const result = await CustomBlock.updateMany({ district: oldDistrict.trim() }, { $set: { district: trimmed } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/blocks/:id — rename a block and/or set its geofence coordinates
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { block_name, latitude, longitude } = req.body;
    const update = {};
    if (block_name !== undefined) {
      if (!block_name.trim()) return res.status(400).json({ success: false, message: 'block_name required' });
      update.block_name = block_name.trim();
    }
    if (latitude !== undefined || longitude !== undefined) {
      const lat = latitude === '' || latitude === null ? null : parseFloat(latitude);
      const lng = longitude === '' || longitude === null ? null : parseFloat(longitude);
      if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) {
        return res.status(400).json({ success: false, message: 'latitude/longitude must be numbers' });
      }
      update.latitude  = lat;
      update.longitude = lng;
    }
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    const block = await CustomBlock.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!block) return res.status(404).json({ success: false, message: 'Block not found' });
    res.json({ success: true, block: { _id: block._id, name: block.block_name, district: block.district, isCustom: !!block.added_by, latitude: block.latitude ?? null, longitude: block.longitude ?? null } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/blocks/:id — remove any block
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const block = await CustomBlock.findByIdAndDelete(req.params.id);
    if (!block) return res.status(404).json({ success: false, message: 'Block not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
