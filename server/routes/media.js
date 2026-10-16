'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Message = require('../models/Message');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { upload, isImageMime, isAudioMime, isVideoMime } = require('../middleware/upload');
const { saveFile, getLocalFilePath, isCloudinary } = require('../services/storageService');

const router = express.Router();

// Helper: calculate expiresAt based on type and env config
function getExpiresAt(type) {
  let hours = 0;
  if (type === 'image') {
    hours = parseInt(process.env.PHOTO_EXPIRY_HOURS) || 24;
  } else if (type === 'audio') {
    hours = parseInt(process.env.VOICE_EXPIRY_HOURS) || 24;
  } else if (type === 'video') {
    // 12 hours auto-delete for videos
    hours = parseInt(process.env.VIDEO_EXPIRY_HOURS) || 12;
  }

  if (hours === 0) return null; // Never expire

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + hours);
  return expiresAt;
}

// Helper: inject or overwrite WebM duration metadata (EBML element 0x4489)
function fixWebmBufferDuration(buf, durationMs) {
  try {
    let infoPos = -1;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] === 0x15 && buf[i+1] === 0x49 && buf[i+2] === 0xA9 && buf[i+3] === 0x66) {
        infoPos = i;
        break;
      }
    }
    if (infoPos === -1) return buf;

    let pos = infoPos + 4;
    const firstByte = buf[pos];
    let numBytes = 1;
    let mask = 0x80;
    while ((firstByte & mask) === 0 && numBytes <= 8) {
      mask >>= 1;
      numBytes++;
    }
    let infoSize = firstByte & (mask - 1);
    for (let i = 1; i < numBytes; i++) {
      infoSize = (infoSize * 256) + buf[pos + i];
    }
    const infoDataStart = pos + numBytes;
    const infoDataEnd = infoDataStart + infoSize;

    // Check if Duration (0x4489) already exists in Info
    for (let i = infoDataStart; i < infoDataEnd - 2; i++) {
      if (buf[i] === 0x44 && buf[i+1] === 0x89) {
        const floatSize = buf[i+2];
        if (floatSize === 4) {
          buf.writeFloatBE(durationMs, i + 3);
          return buf;
        } else if (floatSize === 8) {
          buf.writeDoubleBE(durationMs, i + 3);
          return buf;
        }
      }
    }

    // Inject 0x4489 element
    const durHeader = Buffer.alloc(7);
    durHeader[0] = 0x44;
    durHeader[1] = 0x89;
    durHeader[2] = 0x84; // 4-byte float
    durHeader.writeFloatBE(durationMs, 3);

    const newInfoSize = infoSize + 7;
    let newInfoLenBytes;
    if (newInfoSize < 127) {
      newInfoLenBytes = Buffer.from([0x80 | newInfoSize]);
    } else {
      newInfoLenBytes = Buffer.from([0x40 | (newInfoSize >> 8), newInfoSize & 0xFF]);
    }

    const before = buf.subarray(0, infoPos);
    const infoId = Buffer.from([0x15, 0x49, 0xA9, 0x66]);
    const infoData = buf.subarray(infoDataStart, infoDataEnd);
    const after = buf.subarray(infoDataEnd);

    return Buffer.concat([before, infoId, newInfoLenBytes, infoData, durHeader, after]);
  } catch (err) {
    console.warn('Error patching WebM buffer duration:', err.message);
    return buf;
  }
}

// POST /api/media/upload — upload image, audio, or video file
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const file = req.file;
    const mimeType = file.mimetype;

    // Determine type
    let messageType;
    if (isImageMime(mimeType)) {
      messageType = 'image';
    } else if (isAudioMime(mimeType)) {
      messageType = 'audio';
    } else if (isVideoMime(mimeType)) {
      messageType = 'video';
    } else {
      return res.status(400).json({ error: 'Unsupported file type.' });
    }

    // Parse duration from request (for audio or video)
    const duration = req.body.duration ? parseFloat(req.body.duration) : null;

    // Server-side WebM duration safeguard: patch duration metadata directly onto file on disk
    if ((messageType === 'video' || messageType === 'audio') && file.path && fs.existsSync(file.path)) {
      const isWebm = (file.filename && file.filename.endsWith('.webm')) || (mimeType && mimeType.includes('webm'));
      if (isWebm && duration && duration > 0) {
        try {
          const rawBuffer = fs.readFileSync(file.path);
          const patched = fixWebmBufferDuration(rawBuffer, duration * 1000);
          fs.writeFileSync(file.path, patched);
          file.size = patched.length;
        } catch (e) {
          console.warn('Could not patch WebM duration on disk:', e.message);
        }
      }
    }

    // Find the other user (receiver)
    const otherUser = await User.findOne({ _id: { $ne: req.user._id } });
    if (!otherUser) {
      return res.status(500).json({ error: 'Could not find receiver.' });
    }

    // Save to storage (local or Cloudinary)
    const { storageKey, url } = await saveFile(file);

    // Calculate expiration
    const expiresAt = getExpiresAt(messageType);

    // Create message record in MongoDB
    const message = await Message.create({
      senderId: req.user._id,
      receiverId: otherUser._id,
      type: messageType,
      mediaUrl: url,
      mediaStorageKey: storageKey,
      mimeType,
      fileSize: file.size,
      duration,
      expiresAt,
      replyTo: req.body.replyTo || null,
      clientMessageId: req.body.clientMessageId || null,
    });

    // Populate sender & receiver info for socket broadcast
    await message.populate('senderId', 'username displayName');
    await message.populate('receiverId', 'username displayName');
    if (message.replyTo) {
      await message.populate({
        path: 'replyTo',
        select: 'text type mediaUrl senderId deletedForEveryone',
        populate: { path: 'senderId', select: 'displayName username' },
      });
    }

    res.json({
      success: true,
      message: message.toObject(),
    });
  } catch (err) {
    console.error('Media upload error:', err.message);

    // Handle multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: `File too large. Maximum size is ${process.env.MAX_FILE_SIZE_MB || 50}MB.`,
      });
    }

    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// GET /api/media/:filename — serve a media or avatar file
router.get('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    // Prevent path traversal attacks
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    // For Cloudinary, redirect if configured
    if (isCloudinary()) {
      const message = await Message.findOne({ mediaStorageKey: filename });
      if (message && message.mediaUrl) {
        return res.redirect(message.mediaUrl);
      }
    }

    // For local storage, check file in uploads/ directory
    const filePath = getLocalFilePath(filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server.' });
    }

    // Set content headers
    const ext = filename.split('.').pop().toLowerCase();
    const mimeTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      weba: 'audio/webm',
      webm: 'video/webm',
      ogg: 'video/ogg',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      '3gp': 'video/3gpp',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      bin: 'video/mp4',
    };
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Serve file with full HTTP 206 Byte-Range streaming for smooth video/audio playback
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const downloadFilename = (req.query.filename && !req.query.filename.includes('/') && !req.query.filename.includes('\\'))
      ? req.query.filename
      : `chat-media.${ext}`;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || start >= fileSize) {
        res.status(416).set('Content-Range', `bytes */${fileSize}`).send('Requested range not satisfiable');
        return;
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ...(req.query.download === 'true' ? { 'Content-Disposition': `attachment; filename="${downloadFilename}"` } : {}),
      });

      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        ...(req.query.download === 'true' ? { 'Content-Disposition': `attachment; filename="${downloadFilename}"` } : {}),
      });

      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('Media serve error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to serve file.' });
    }
  }
});

module.exports = router;
