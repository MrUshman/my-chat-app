'use strict';

const express = require('express');
const Message = require('../models/Message');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/messages?before=<messageId>&limit=20
// Returns paginated messages for the conversation, newest first
router.get('/', requireAuth, async (req, res) => {
  try {
    const PAGE_SIZE = 20;
    const { before, limit } = req.query;

    // 48-Hour Auto-Delete Cutoff: never return messages older than 48 hours
    const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Build query: messages between the two users, excluding deleted messages
    const query = {
      $or: [
        { senderId: req.user._id, deletedForSender: { $ne: true } },
        { receiverId: req.user._id, deletedForReceiver: { $ne: true } },
      ],
      createdAt: { $gte: cutoffDate },
    };

    // Cursor-based pagination: get messages before a given message ID
    if (before) {
      const cursorMessage = await Message.findById(before).select('createdAt').lean();
      if (cursorMessage) {
        query.createdAt = { $lt: cursorMessage.createdAt, $gte: cutoffDate };
      }
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit) || PAGE_SIZE, 50))
      .populate('senderId', 'username displayName profileImage')
      .populate('receiverId', 'username displayName profileImage')
      .populate({
        path: 'replyTo',
        select: 'text type mediaUrl senderId deletedForEveryone',
        populate: { path: 'senderId', select: 'displayName username' },
      })
      .lean();

    // Return in chronological order (oldest first for rendering)
    messages.reverse();

    res.json({
      messages,
      hasMore: messages.length === (parseInt(limit) || PAGE_SIZE),
    });
  } catch (err) {
    console.error('Get messages error:', err.message);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

// PATCH /api/messages/:id/read — mark a message as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      receiverId: req.user._id, // only the receiver can mark as read
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    if (!message.readAt) {
      message.readAt = new Date();
      await message.save();
    }

    res.json({ success: true, readAt: message.readAt });
  } catch (err) {
    console.error('Mark read error:', err.message);
    res.status(500).json({ error: 'Failed to mark message as read.' });
  }
});

// PUT /api/messages/:id/react — toggle reaction on a message
router.put('/:id/react', requireAuth, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required.' });
    }

    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    // Check if user already reacted
    const existingIndex = message.reactions.findIndex(
      r => r.userId.toString() === req.user._id.toString()
    );

    if (existingIndex > -1) {
      if (message.reactions[existingIndex].emoji === emoji) {
        // Same emoji -> remove reaction (toggle off)
        message.reactions.splice(existingIndex, 1);
      } else {
        // Different emoji -> update reaction
        message.reactions[existingIndex].emoji = emoji;
        message.reactions[existingIndex].createdAt = new Date();
      }
    } else {
      // Add new reaction
      message.reactions.push({
        userId: req.user._id,
        emoji,
        createdAt: new Date(),
      });
    }

    await message.save();

    res.json({
      success: true,
      messageId: message._id,
      reactions: message.reactions,
      senderId: message.senderId,
      receiverId: message.receiverId,
    });
  } catch (err) {
    console.error('React to message error:', err.message);
    res.status(500).json({ error: 'Failed to update reaction.' });
  }
});

// DELETE /api/messages/:id?type=me|everyone — Delete for Me or Delete for Everyone
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { type } = req.query; // 'me' or 'everyone'
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    const isSender = message.senderId.toString() === req.user._id.toString();
    const isReceiver = message.receiverId.toString() === req.user._id.toString();

    if (!isSender && !isReceiver) {
      return res.status(403).json({ error: 'Unauthorized to delete this message.' });
    }

    if (type === 'everyone') {
      message.deletedForEveryone = true;
      message.text = '🚫 This message was deleted';
    } else {
      // Delete for me
      if (isSender) message.deletedForSender = true;
      if (isReceiver) message.deletedForReceiver = true;
    }

    await message.save();

    res.json({
      success: true,
      messageId: message._id,
      type: type === 'everyone' ? 'everyone' : 'me',
      senderId: message.senderId,
      receiverId: message.receiverId,
      deletedForEveryone: message.deletedForEveryone,
    });
  } catch (err) {
    console.error('Delete message error:', err.message);
    res.status(500).json({ error: 'Failed to delete message.' });
  }
});

// POST /api/messages/bulk-delete — Delete multiple messages (Delete for Me or Everyone)
router.post('/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { messageIds, type } = req.body;
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: 'messageIds array is required.' });
    }

    const userId = req.user._id.toString();
    const messages = await Message.find({ _id: { $in: messageIds } });

    const deletedIds = [];
    for (const msg of messages) {
      const isSender = msg.senderId.toString() === userId;
      const isReceiver = msg.receiverId.toString() === userId;
      if (!isSender && !isReceiver) continue;

      if (type === 'everyone') {
        if (isSender) { // only sender can delete for everyone
          msg.deletedForEveryone = true;
          msg.text = '🚫 This message was deleted';
          await msg.save();
          deletedIds.push(msg._id);
        }
      } else {
        // delete for me
        if (isSender) msg.deletedForSender = true;
        if (isReceiver) msg.deletedForReceiver = true;
        await msg.save();
        deletedIds.push(msg._id);
      }
    }

    res.json({
      success: true,
      deletedIds,
      type,
    });
  } catch (err) {
    console.error('Bulk delete error:', err.message);
    res.status(500).json({ error: 'Failed to bulk delete messages.' });
  }
});

module.exports = router;
