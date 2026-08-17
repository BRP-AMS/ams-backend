const express    = require('express');
const router     = express.Router();
const { Holiday } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const MANAGE_ROLES = ['admin', 'super_admin', 'manager'];

const SEED_2026 = [
  { date: '2026-01-14', name: 'Pous Parban',                                        type: 'public' },
  { date: '2026-01-23', name: 'Birthday of Netaji Subhash Chandra Bose',            type: 'public' },
  { date: '2026-01-26', name: 'Republic Day',                                        type: 'public' },
  { date: '2026-03-04', name: 'Holi',                                                type: 'public' },
  { date: '2026-03-21', name: 'Id-ul-Fitr',                                          type: 'public' },
  { date: '2026-04-03', name: 'Good Friday',                                         type: 'public' },
  { date: '2026-04-14', name: 'Biju/Buisu Festival',                                 type: 'state'  },
  { date: '2026-04-15', name: "Bengali New Year's Day",                              type: 'state'  },
  { date: '2026-04-21', name: 'Garia Puja',                                          type: 'state'  },
  { date: '2026-05-01', name: 'Buddha Purnima',                                      type: 'public' },
  { date: '2026-05-26', name: 'Birthday of Kazi Nazrul Islam',                       type: 'public' },
  { date: '2026-05-27', name: 'Id-ul-Zuha (Bakrid)',                                 type: 'public' },
  { date: '2026-06-26', name: 'Muharram',                                             type: 'public' },
  { date: '2026-07-22', name: 'Kharchi Puja',                                        type: 'state'  },
  { date: '2026-08-04', name: 'Ker Puja',                                             type: 'state'  },
  { date: '2026-08-15', name: 'Independence Day',                                    type: 'public' },
  { date: '2026-08-19', name: 'Birthday of Maharaja Bir Bikram Kishore Manikya Bahadur', type: 'state' },
  { date: '2026-08-26', name: 'Birthday of Prophet Mohammad',                        type: 'public' },
  { date: '2026-09-04', name: 'Janmashtami',                                         type: 'public' },
  { date: '2026-10-02', name: "Mahatma Gandhi's Birthday",                           type: 'public' },
  { date: '2026-10-17', name: 'Maha Saptami',                                        type: 'state'  },
  { date: '2026-10-19', name: 'Maha Ashtami',                                        type: 'state'  },
  { date: '2026-10-20', name: 'Maha Navami',                                         type: 'state'  },
  { date: '2026-10-21', name: 'Vijaya Dashami',                                      type: 'state'  },
  { date: '2026-10-22', name: 'Vijaya Dashami (Holiday)',                            type: 'state'  },
  { date: '2026-10-23', name: 'Post-Puja Holiday',                                   type: 'state'  },
  { date: '2026-10-26', name: 'Laxmi Puja',                                          type: 'state'  },
  { date: '2026-11-09', name: 'Diwali',                                               type: 'public' },
  { date: '2026-12-25', name: 'Christmas Day',                                        type: 'public' },
];

// GET /api/holidays?year=2026 — all roles
router.get('/', authenticate, async (req, res) => {
  try {
    const { year } = req.query;
    const filter = year
      ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }
      : {};
    const holidays = await Holiday.find(filter).sort({ date: 1 }).lean();
    res.json({ success: true, data: holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/holidays — admin, super_admin, manager
router.post('/', authenticate, authorize(...MANAGE_ROLES), async (req, res) => {
  try {
    const { date, name, type } = req.body;
    if (!date || !name) return res.status(400).json({ success: false, message: 'date and name required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });

    const holiday = await Holiday.create({ date, name: name.trim(), type: type || 'public', added_by: req.user.id });
    res.status(201).json({ success: true, data: holiday });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'A holiday already exists on that date' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/holidays/:id — admin, super_admin, manager
router.put('/:id', authenticate, authorize(...MANAGE_ROLES), async (req, res) => {
  try {
    const { name, type } = req.body;
    const updated = await Holiday.findByIdAndUpdate(
      req.params.id,
      { $set: { ...(name ? { name: name.trim() } : {}), ...(type ? { type } : {}) } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Holiday not found' });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/holidays/:id — admin, super_admin only
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const deleted = await Holiday.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Holiday not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/holidays/seed — seeds 2026 Tripura list (skips existing dates)
router.post('/seed', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    let inserted = 0, skipped = 0;
    for (const h of SEED_2026) {
      const exists = await Holiday.exists({ date: h.date });
      if (exists) { skipped++; continue; }
      await Holiday.create({ ...h, added_by: req.user.id });
      inserted++;
    }
    res.json({ success: true, inserted, skipped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
