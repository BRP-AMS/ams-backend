const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a buffer to Cloudinary.
 * @param {Buffer} buffer - file buffer from multer memoryStorage
 * @param {string} folder - Cloudinary folder name (e.g. 'ams/selfies')
 * @param {string} [resourceType] - 'image' | 'raw' | 'auto' (default: 'auto')
 * @returns {Promise<string>} secure_url
 */
const uploadToCloudinary = (buffer, folder, resourceType = 'auto') => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    ).end(buffer);
  });
};

module.exports = { uploadToCloudinary };