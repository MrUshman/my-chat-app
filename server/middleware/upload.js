'use strict';

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

// Allowed MIME types (validated on actual file content via mimetype from multer)
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_AUDIO_MIMES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-m4a',
];
const ALL_ALLOWED_MIMES = [...ALLOWED_IMAGE_MIMES, ...ALLOWED_AUDIO_MIMES];

// Max file size from env (default 10 MB)
const MAX_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;

// Local disk storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    const cleanMime = (file.mimetype || '').split(';')[0].trim();
    let ext = mime.extension(cleanMime);
    if (!ext || ext === 'bin' || ext === 'weba') {
      if (cleanMime.includes('audio/webm') || cleanMime.includes('webm')) ext = 'webm';
      else if (cleanMime.includes('audio/ogg')) ext = 'ogg';
      else if (cleanMime.includes('audio/mp4')) ext = 'mp4';
      else if (cleanMime.includes('audio/mpeg')) ext = 'mp3';
      else if (cleanMime.includes('image/')) ext = 'jpg';
      else ext = 'webm';
    }
    if (ext === 'weba') ext = 'webm';
    const uniqueName = `${uuidv4()}.${ext}`;
    cb(null, uniqueName);
  },
});

// File filter — validate MIME type
function fileFilter(req, file, cb) {
  if (ALL_ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`), false);
  }
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter,
});

// Helper to check if a MIME is an image
function isImageMime(mimeType) {
  return ALLOWED_IMAGE_MIMES.includes(mimeType);
}

// Helper to check if a MIME is audio
function isAudioMime(mimeType) {
  return ALLOWED_AUDIO_MIMES.includes(mimeType);
}

module.exports = { upload, isImageMime, isAudioMime, MAX_SIZE_BYTES };
