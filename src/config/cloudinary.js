// src/config/cloudinary.js
const cloudinary            = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer                = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'drvvupxhz',
  api_key:    process.env.CLOUDINARY_API_KEY    || '719965482646155',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'SWqebIRK3O8-GsVvb-uzLe16vcg',
  secure:     true,
});

const getResourceType = (mimetype) => {
  if (mimetype.startsWith('image/'))  return 'image';
  if (mimetype.startsWith('video/'))  return 'video';
  return 'raw';
};

const makeStorage = (folder) => new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder,
    resource_type: 'auto', // ✅ important
    public_id: `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '').replace(/\s+/g, '_')}`,
    ...(file.mimetype.startsWith('image/') && {
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    }),
  }),
});

// ── Selfie uploader (checkin / checkout photos) ───────────────────────────
const selfieUploader = multer({
  storage: makeStorage('brp/attendance/selfies'),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

// ── Activity document uploader ────────────────────────────────────────────
const activityUploader = multer({
  storage: makeStorage('brp/activities/documents'),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(file.originalname.split('.').pop().toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── Schedule attachment uploader ──────────────────────────────────────────
const scheduleUploader = multer({
  storage: makeStorage('brp/schedules/attachments'),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(file.originalname.split('.').pop().toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── Reapply docs uploader (attendance re-apply) ───────────────────────────
const reapplyUploader = multer({
  storage: makeStorage('brp/attendance/reapply'),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx/;
    if (allowed.test(file.originalname.split('.').pop().toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── Bulk Excel uploader (kept in memory — NOT sent to Cloudinary) ─────────
const bulkExcelUploader = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/xlsx|xls|csv/.test(file.originalname.split('.').pop().toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
  },
});

// ── Delete file from Cloudinary ───────────────────────────────────────────
const deleteFromCloudinary = async (publicIdOrUrl) => {
  try {
    if (!publicIdOrUrl) return;
    let publicId = publicIdOrUrl;
    if (publicIdOrUrl.startsWith('http')) {
      const parts     = publicIdOrUrl.split('/');
      const uploadIdx = parts.indexOf('upload');
      if (uploadIdx !== -1) {
        const afterUpload = parts.slice(uploadIdx + 1).filter(p => !/^v\d+$/.test(p));
        publicId = afterUpload.join('/').replace(/\.[^/.]+$/, '');
      }
    }
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
};

module.exports = {
  cloudinary,
  selfieUploader,
  activityUploader,
  scheduleUploader,
  reapplyUploader,
  bulkExcelUploader,
  deleteFromCloudinary,
};