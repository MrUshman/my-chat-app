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
    // 7 Days (1 Week) cutoff
    const autoDeleteCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 1. Permanently delete all messages older than 7 days (text & media)
    const oldMessages = await Message.find({
      createdAt: { $lte: autoDeleteCutoff },
    }).select('_id mediaStorageKey').lean();

    if (oldMessages.length > 0) {
      console.log(`🧹 7-Day Cleanup: found ${oldMessages.length} message(s) older than 7 days.`);

      // Clean up files for any media messages before deleting record
      for (const msg of oldMessages) {
        if (msg.mediaStorageKey) {
          try {
            await deleteFile(msg.mediaStorageKey);
          } catch (err) {
            console.error(`Failed to delete media for message ${msg._id}:`, err.message);
          }
        }
      }

      const deleteRes = await Message.deleteMany({
        createdAt: { $lte: autoDeleteCutoff },
      });
      console.log(`✅ Permanently deleted ${deleteRes.deletedCount} message(s) older than 7 days.`);
    }

    // 2. Also clean up any earlier expired media messages (expiresAt <= now)
    const expiredMessages = await Message.find({
      type: { $in: ['image', 'audio', 'video'] },
      expiresAt: { $lte: now },
      mediaDeleted: false,
      mediaStorageKey: { $ne: null },
    }).select('_id mediaStorageKey').lean();

    for (const msg of expiredMessages) {
      try {
        await deleteFile(msg.mediaStorageKey);
        await Message.findByIdAndUpdate(msg._id, {
          mediaDeleted: true,
          mediaUrl: null,
          mediaStorageKey: null,
        });
        console.log(`✅ Cleaned up expired media: ${msg._id}`);
      } catch (err) {
        console.error(`Failed to cleanup media message ${msg._id}:`, err.message);
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
