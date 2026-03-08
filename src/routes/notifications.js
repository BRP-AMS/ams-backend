const express = require('express');
const router  = express.Router();
const { Notification } = require('../models/database');
const { authenticate } = require('../middleware/auth');

// GET /api/notifications
router.get('/', authenticate, async (req, res) => {
  try {
    const notifications = await Notification
      .find({ user_id: req.user.id })
      .sort({ created_at: -1 })
      .limit(50)
      .lean();

    const unreadCount = await Notification.countDocuments({ user_id: req.user.id, is_read: 0 });
    res.json({
      success: true,
      data: notifications.map(n => ({
        id:                n._id,
        title:             n.title,
        message:           n.message,
        type:              n.type,
        is_read:           n.is_read,
        related_record_id: n.related_record_id,
        link:              n.link || null,
        created_at:        n.created_at,
      })),
      unreadCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    await Notification.updateOne({ _id: req.params.id, user_id: req.user.id }, { $set: { is_read: 1 } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/notifications/read-all
router.put('/read-all', authenticate, async (req, res) => {
  try {
    await Notification.updateMany({ user_id: req.user.id }, { $set: { is_read: 1 } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
