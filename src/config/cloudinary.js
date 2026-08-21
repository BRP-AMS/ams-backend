// src/config/cloudinary.js
const cloudinary = require('cloudinary').v2;
const multer      = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME ,
  api_key:    process.env.CLOUDINARY_API_KEY    ,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

const getResourceType = (mimetype) => {
  if (mimetype.startsWith('image/'))  return 'image';
  if (mimetype.startsWith('video/'))  return 'video';
  return 'raw';
};

// ── Shared employee-folder naming helper ───────────────────────────────────
// Single source of truth so EVERY route that uploads employee files
// (signed reports, monthly reports, reapply docs, etc.) nests under the
// SAME parent folder, e.g. "krishna(456)", instead of each route building
// its own (different) folder string.
const slugify = (str = '') =>
  String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';

// name -> "krishna", empId/fallbackId -> "456"  =>  "krishna(456)"
const employeeFolderPath = (empId, fallbackId) =>
  `users/${empId || fallbackId}`;

// Upload a buffer to Cloudinary (replaces multer-storage-cloudinary)
const uploadBufferToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) =>
      err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });

// Builds Cloudinary upload params for a given file (mirrors the old
// makeStorage() params function, but called manually after multer
// buffers the file in memory).
const buildUploadOptions = (folder, file, { skipAutoTransform = false } = {}) => {
  const ext      = file.originalname.split('.').pop().toLowerCase();
  const baseName = file.originalname.replace(/\.[^/.]+$/, '').replace(/\s+/g, '_');
  const isImage  = file.mimetype.startsWith('image/');

  return {
    folder,
    resource_type: 'auto',
    public_id: isImage
      ? `${Date.now()}_${baseName}`
      : `${Date.now()}_${baseName}.${ext}`,
    ...(isImage && !skipAutoTransform && {
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    }),
  };
};

// ── Selfie uploader (checkin / checkout photos) ───────────────────────────
const selfieUploader = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

// ── Activity document uploader ────────────────────────────────────────────
const activityUploader = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(file.originalname.split('.').pop().toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── Schedule attachment uploader ──────────────────────────────────────────
const scheduleUploader = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(file.originalname.split('.').pop().toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── Reapply docs uploader (attendance re-apply) ───────────────────────────
const reapplyUploader = multer({
  storage: multer.memoryStorage(),
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
  slugify,
 employeeFolderPath, 
  uploadBufferToCloudinary,
  buildUploadOptions,
};