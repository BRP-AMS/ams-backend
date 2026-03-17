/**
 * Cloudflare R2 storage utility (S3-compatible)
 * Drop-in replacement for local disk storage.
 * All uploaded files are stored in R2 and returned as public HTTPS URLs.
 */
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET     = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, ''); // no trailing slash

/**
 * Upload a file buffer to R2.
 * @param {Buffer}  buffer       - file buffer from multer memoryStorage
 * @param {string}  folder       - R2 folder prefix  e.g. 'ams/selfies'
 * @param {string}  originalName - original filename (for extension)
 * @param {string}  [mimeType]   - MIME type
 * @returns {Promise<string>}    - public HTTPS URL
 */
const uploadFile = async (buffer, folder, originalName, mimeType) => {
  const ext = path.extname(originalName || '') || '';
  const key = `${folder}/${uuidv4()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType || 'application/octet-stream',
  }));

  return `${PUBLIC_URL}/${key}`;
};

/**
 * Delete a file from R2 by its public URL.
 * Safe to call — ignores errors if file not found.
 */
const deleteFile = async (url) => {
  if (!url || !PUBLIC_URL) return;
  try {
    const key = url.replace(`${PUBLIC_URL}/`, '');
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (_) { /* ignore */ }
};

module.exports = { uploadFile, deleteFile };
