'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Message = require('../models/Message');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { upload, isImageMime, isAudioMime } = require('../middleware/upload');
const { saveFile, getLocalFilePath, isCloudinary } = require('../services/storageService');

const router = express.Router();

// Helper: calculate expiresAt based on type and env config
function getExpiresAt(type) {
  let hours = 0;
  if (type === 'image') {
    hours = parseInt(process.env.PHOTO_EXPIRY_HOURS) || 24;
  } else if (type === 'audio') {
    hours = parseInt(process.env.VOICE_EXPIRY_HOURS) || 24;
  }

  if (hours === 0) return null; // Never expire

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + hours);
  return expiresAt;
}

// POST /api/media/upload — upload image or audio file
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
    } else {
      return res.status(400).json({ error: 'Unsupported file type.' });
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

    // Parse duration from request (for audio)
    const duration = req.body.duration ? parseFloat(req.body.duration) : null;

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
    });

    // Populate sender info for socket broadcast
    await message.populate('senderId', 'username displayName profileImage');
    await message.populate('receiverId', 'username displayName profileImage');

    res.json({
      success: true,
      message: message.toObject(),
    });
  } catch (err) {
    console.error('Media upload error:', err.message);

    // Handle multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: `File too large. Maximum size is ${process.env.MAX_FILE_SIZE_MB || 10}MB.`,
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
      webm: 'audio/webm',
      ogg: 'audio/ogg',
      mp3: 'audio/mpeg',
      mp4: 'audio/mp4',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      bin: 'audio/webm',
    };
    
    const contentType = mimeTypes[ext] || 'audio/webm';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // Handle attachment download query
    if (req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="media.${ext}"`);
    }

    res.sendFile(filePath, {
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      }
    });
  } catch (err) {
    console.error('Media serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve file.' });
  }
});

module.exports = router;
