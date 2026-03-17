/**
 * Unified file storage utility.
 *
 * Provider is selected automatically based on env vars:
 *   - R2_ACCOUNT_ID set  →  Cloudflare R2  (production)
 *   - Otherwise          →  Cloudinary     (free, no card needed — use for dev/testing)
 *
 * Both return a permanent public HTTPS URL per file.
 */
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ── Cloudflare R2 (S3-compatible) ─────────────────────────────────────────
const uploadViaR2 = async (buffer, folder, originalName, mimeType) => {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region:   'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const ext        = path.extname(originalName || '') || '';
  const key        = `${folder}/${uuidv4()}${ext}`;
  const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  await s3.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType || 'application/octet-stream',
  }));
  return `${PUBLIC_URL}/${key}`;
};

// ── Cloudinary (free 25GB, no card) ──────────────────────────────────────
const uploadViaCloudinary = (buffer, folder) => {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, resource_type: 'auto' },
      (err, result) => { if (err) reject(err); else resolve(result.secure_url); }
    ).end(buffer);
  });
};

// ── Public API ────────────────────────────────────────────────────────────
const uploadFile = (buffer, folder, originalName, mimeType) => {
  if (process.env.R2_ACCOUNT_ID) {
    return uploadViaR2(buffer, folder, originalName, mimeType);
  }
  return uploadViaCloudinary(buffer, folder);
};

const deleteFile = async () => { /* no-op — files managed by provider */ };

module.exports = { uploadFile, deleteFile };
