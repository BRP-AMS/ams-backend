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

/**
 * Upload a buffer to Cloudinary.
 * @param {Buffer} buffer  - File buffer from multer memoryStorage
 * @param {string} folder  - Cloudinary folder e.g. 'ams/selfies'
 * @returns {Promise<string>} Secure HTTPS URL
 */
const uploadFile = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, resource_type: 'auto' },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    ).end(buffer);
  });
};

const deleteFile = async () => { /* managed by Cloudinary */ };

module.exports = { uploadFile, deleteFile };