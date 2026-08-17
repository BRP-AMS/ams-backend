/**
 * File storage utility — Cloudinary
 * All uploads go to Cloudinary. Returns a permanent public HTTPS URL.
 */
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const IMAGE_TYPES = /^image\//;
const VIDEO_TYPES = /^video\//;

const getResourceType = (mimetype) => {
  if (!mimetype) return 'auto';
  if (IMAGE_TYPES.test(mimetype)) return 'image';
  if (VIDEO_TYPES.test(mimetype)) return 'video';
  return 'raw'; // PDFs, Word, Excel, etc. → /raw/upload/ → viewable inline
};

/**
 * Upload a buffer to Cloudinary.
 * @param {Buffer} buffer     - File buffer from multer memoryStorage
 * @param {string} folder     - Cloudinary folder e.g. 'ams/users/EMP001/selfies'
 * @param {string} filename   - Original filename (used as fallback public_id base)
 * @param {string} mimetype   - MIME type used to pick correct resource_type
 * @param {string} [customName] - Optional Cloudinary public_id (without folder); used to give
 *                               meaningful names e.g. "AjayKumar_EMP001_checkin_selfie_1234567890"
 * @returns {Promise<string>} Secure HTTPS URL
 */
const uploadFile = (buffer, folder, filename, mimetype, customName) => {
  return new Promise((resolve, reject) => {
    const opts = { folder, resource_type: getResourceType(mimetype) };
    if (customName) opts.public_id = customName;
    cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) reject(err);
      else resolve(result.secure_url);
    }).end(buffer);
  });
};

const deleteFile = async () => { /* managed by Cloudinary */ };

module.exports = { uploadFile, deleteFile };
