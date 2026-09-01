'use strict';

/**
 * Cleanup Service
 * Runs on a cron schedule to find and delete expired media files.
 * Only deletes image/audio files — text messages are NEVER touched.
 */

const cron = require('node-cron');
const Message = require('../models/Message');
const { deleteFile } = require('./storageService');

/**
 * Find all expired media messages and delete their files.
 * Updates the message record to mark mediaDeleted=true.
 */
async function runCleanup() {
  try {
    const now = new Date();

    // Find expired media messages that haven't been cleaned up yet
    const expiredMessages = await Message.find({
      type: { $in: ['image', 'audio'] },
      expiresAt: { $lte: now },
      mediaDeleted: false,
      mediaStorageKey: { $ne: null },
    });

    if (expiredMessages.length === 0) {
      return; // Nothing to clean up
    }

    console.log(`🧹 Cleanup: found ${expiredMessages.length} expired media message(s)`);

    for (const msg of expiredMessages) {
      try {
        // Delete the actual file from storage
        await deleteFile(msg.mediaStorageKey);

        // Mark message as media-deleted (keep message record for chat history)
        await Message.findByIdAndUpdate(msg._id, {
          mediaDeleted: true,
          mediaUrl: null,
          mediaStorageKey: null,
        });

        console.log(`✅ Cleaned up ${msg.type} message: ${msg._id}`);
      } catch (err) {
        console.error(`Failed to cleanup message ${msg._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Cleanup service error:', err.message);
  }
}

/**
 * Start the cleanup cron job.
 * Runs every 30 minutes.
 */
function startCleanupService() {
  console.log('🕐 Cleanup service started (runs every 30 minutes)');

  // Run immediately on startup to catch any missed expirations
  runCleanup();

  // Then run every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    console.log('🧹 Running scheduled media cleanup...');
    runCleanup();
  });
}

module.exports = { startCleanupService, runCleanup };
