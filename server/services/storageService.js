'use strict';

/**
 * Storage Service
 * Abstracts file storage so it's easy to swap local ↔ Cloudinary.
 *
 * Current mode is determined by env:
 * - If CLOUDINARY_CLOUD_NAME is set → use Cloudinary
 * - Otherwise → use local filesystem (uploads/ folder)
 */

const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── LOCAL STORAGE ────────────────────────────────────────────────────────────

/**
 * For local storage, the file is already on disk (multer saved it).
 * We just return metadata.
 *
 * @param {Object} file - Multer file object
 * @returns {Object} { storageKey, url }
 */
function localSave(file) {
  const storageKey = file.filename; // e.g. "uuid.jpg"
  const url = `/api/media/${file.filename}`;
  return { storageKey, url };
}

/**
 * Delete a file from local storage.
 * @param {string} storageKey - filename in uploads/ dir
 */
async function localDelete(storageKey) {
  const filePath = path.join(UPLOADS_DIR, storageKey);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Deleted local file: ${storageKey}`);
    }
  } catch (err) {
    console.error(`Failed to delete local file ${storageKey}:`, err.message);
  }
}

/**
 * Get the full filesystem path for a local file.
 * @param {string} storageKey
 */
function localGetPath(storageKey) {
  return path.join(UPLOADS_DIR, storageKey);
}

// ─── CLOUDINARY STORAGE ───────────────────────────────────────────────────────
// Uncomment and configure if CLOUDINARY env vars are set.

let cloudinary = null;

async function initCloudinary() {
  if (!cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
    try {
      const { v2 } = require('cloudinary');
      v2.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      cloudinary = v2;
      console.log('✅ Cloudinary configured');
    } catch (err) {
      console.warn('⚠️  Cloudinary not installed. Falling back to local storage.');
    }
  }
  return cloudinary;
}

async function cloudinarySave(filePath, folder = 'chat') {
  const cl = await initCloudinary();
  const result = await cl.uploader.upload(filePath, {
    folder,
    resource_type: 'auto',
  });
  return {
    storageKey: result.public_id,
    url: result.secure_url,
  };
}

async function cloudinaryDelete(storageKey) {
  const cl = await initCloudinary();
  try {
    await cl.uploader.destroy(storageKey, { resource_type: 'auto' });
    console.log(`🗑️  Deleted Cloudinary file: ${storageKey}`);
  } catch (err) {
    console.error(`Failed to delete Cloudinary file ${storageKey}:`, err.message);
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

const isCloudinary = () => !!process.env.CLOUDINARY_CLOUD_NAME;

/**
 * Save an uploaded file.
 * @param {Object} file - Multer file object (file.path, file.filename, etc.)
 * @returns {Promise<{storageKey: string, url: string}>}
 */
async function saveFile(file) {
  if (isCloudinary()) {
    const result = await cloudinarySave(file.path);
    // Remove local temp file after Cloudinary upload
    try { fs.unlinkSync(file.path); } catch {}
    return result;
  }
  return localSave(file);
}

/**
 * Delete a stored file by its storage key.
 * @param {string} storageKey
 */
async function deleteFile(storageKey) {
  if (isCloudinary()) {
    return cloudinaryDelete(storageKey);
  }
  return localDelete(storageKey);
}

/**
 * Get a readable stream or path for serving a local file.
 * Not used for Cloudinary (files served directly via Cloudinary CDN).
 */
function getLocalFilePath(storageKey) {
  return localGetPath(storageKey);
}

module.exports = { saveFile, deleteFile, getLocalFilePath, isCloudinary };
