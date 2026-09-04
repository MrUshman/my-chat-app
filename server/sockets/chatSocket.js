'use strict';

/**
 * Chat Socket Handler
 * Manages all real-time Socket.IO events for the private chat.
 */

const Message = require('../models/Message');
const User = require('../models/User');

// Track online users: Map<userIdString, Set<socketId>>
const onlineUsers = new Map();

function registerUser(userId, socketId) {
  const uid = userId ? userId.toString() : '';
  if (!uid) return;
  if (!onlineUsers.has(uid)) {
    onlineUsers.set(uid, new Set());
  }
  onlineUsers.get(uid).add(socketId);
}

function unregisterUser(userId, socketId) {
  const uid = userId ? userId.toString() : '';
  if (!uid) return;
  if (onlineUsers.has(uid)) {
    onlineUsers.get(uid).delete(socketId);
    if (onlineUsers.get(uid).size === 0) {
      onlineUsers.delete(uid);
    }
  }
}

function isUserOnline(userId) {
  if (!userId) return false;
  const uid = userId.toString();
  return onlineUsers.has(uid) && onlineUsers.get(uid).size > 0;
}

/**
 * Initialize Socket.IO handlers on the server.
 * @param {import('socket.io').Server} io
 */
function initChatSocket(io) {
  io.on('connection', async (socket) => {
    const user = socket.user;
    if (!user || !user._id) {
      return socket.disconnect(true);
    }

    const userId = user._id.toString();

    console.log(`🔌 ${user.displayName} connected [${socket.id}]`);

    // Register this socket and join user room
    registerUser(userId, socket.id);
    socket.join(userId);

    // Send partner's current status directly to this user on connect
    try {
      const partner = await User.findOne({ _id: { $ne: user._id } }).select('username displayName profileImage lastSeen');
      if (partner) {
        const partnerOnline = isUserOnline(partner._id.toString());
        socket.emit('partner_status', {
          partner: partner.toSafeObject(),
          isOnline: partnerOnline,
          lastSeen: partner.lastSeen,
        });
      }
    } catch (err) {
      console.error('Partner status emit error:', err.message);
    }

    // Notify the other user that this user is online
    socket.broadcast.emit('user_online', {
      userId,
      displayName: user.displayName,
    });

    // Mark undelivered messages as delivered now that user is connected
    try {
      const undelivered = await Message.find({
        receiverId: user._id,
        deliveredAt: null,
      });

      if (undelivered.length > 0) {
        const now = new Date();
        const ids = undelivered.map(m => m._id);

        await Message.updateMany(
          { _id: { $in: ids } },
          { deliveredAt: now }
        );

        // Notify sender of delivery status across all tabs
        const otherUser = await User.findOne({ _id: { $ne: user._id } });
        if (otherUser) {
          io.to(otherUser._id.toString()).emit('messages_delivered', {
            messageIds: ids.map(id => id.toString()),
            deliveredAt: now,
          });
        }
      }
    } catch (err) {
      console.error('Delivery update error:', err.message);
    }

    // ─── Send Message ─────────────────────────────────────────────────────────
    socket.on('send_message', async (data, ack) => {
      try {
        if (!data) return ack?.({ error: 'No data provided.' });

        const { text, clientMessageId, replyTo } = data;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
          return ack?.({ error: 'Message text is required.' });
        }

        if (text.length > 5000) {
          return ack?.({ error: 'Message too long.' });
        }

        // Find the other user
        const otherUser = await User.findOne({ _id: { $ne: user._id } });
        if (!otherUser) {
          return ack?.({ error: 'Receiver not found.' });
        }

        const otherUserId = otherUser._id.toString();
        const now = new Date();
        const receiverOnline = isUserOnline(otherUserId);

        // Save to MongoDB
        const message = await Message.create({
          senderId: user._id,
          receiverId: otherUser._id,
          type: 'text',
          text: text.trim(),
          deliveredAt: receiverOnline ? now : null,
          replyTo: replyTo || null,
        });

        await message.populate('senderId', 'username displayName profileImage');
        await message.populate('receiverId', 'username displayName profileImage');
        if (message.replyTo) {
          await message.populate({
            path: 'replyTo',
            select: 'text type mediaUrl senderId deletedForEveryone',
            populate: { path: 'senderId', select: 'displayName username' },
          });
        }

        const msgObj = message.toObject();
        msgObj.clientMessageId = clientMessageId; // echo back for dedup

        // Broadcast to sender room (all tabs of current user)
        io.to(userId).emit('receive_message', msgObj);

        // Broadcast to receiver room if online
        if (receiverOnline) {
          io.to(otherUserId).emit('receive_message', msgObj);

          io.to(userId).emit('message_delivered', {
            messageId: message._id.toString(),
            deliveredAt: now,
          });
        }

        ack?.({ success: true, messageId: message._id.toString() });
      } catch (err) {
        console.error('send_message error:', err.message);
        ack?.({ error: 'Failed to send message.' });
      }
    });

    // ─── Media Message (after upload via REST) ────────────────────────────────
    socket.on('send_media_message', async (data, ack) => {
      try {
        if (!data) return ack?.({ error: 'No data provided.' });

        const { messageId } = data;

        if (!messageId) {
          return ack?.({ error: 'messageId is required.' });
        }

        // Find the already-uploaded message
        const message = await Message.findOne({
          _id: messageId,
          senderId: user._id,
        })
          .populate('senderId', 'username displayName profileImage')
          .populate('receiverId', 'username displayName profileImage')
          .populate({
            path: 'replyTo',
            select: 'text type mediaUrl senderId deletedForEveryone',
            populate: { path: 'senderId', select: 'displayName username' },
          });

        if (!message) {
          return ack?.({ error: 'Message not found.' });
        }

        const otherUserId = message.receiverId._id.toString();
        const now = new Date();
        const receiverOnline = isUserOnline(otherUserId);

        // Update delivered status if receiver is online
        if (receiverOnline) {
          message.deliveredAt = now;
          await message.save();
        }

        const msgObj = message.toObject();

        // Broadcast to sender room
        io.to(userId).emit('receive_message', msgObj);

        // Broadcast to receiver room if online
        if (receiverOnline) {
          io.to(otherUserId).emit('receive_message', msgObj);

          io.to(userId).emit('message_delivered', {
            messageId: message._id.toString(),
            deliveredAt: now,
          });
        }

        ack?.({ success: true });
      } catch (err) {
        console.error('send_media_message error:', err.message);
        ack?.({ error: 'Failed to broadcast media message.' });
      }
    });

    // ─── Typing Events ────────────────────────────────────────────────────────
    socket.on('typing_start', () => {
      socket.broadcast.emit('typing_start', {
        userId,
        displayName: user.displayName,
      });
    });

    socket.on('typing_stop', () => {
      socket.broadcast.emit('typing_stop', { userId });
    });

    // ─── Message Read ─────────────────────────────────────────────────────────
    socket.on('message_read', async (data) => {
      try {
        if (!data) return;
        const { messageIds } = data;
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;

        const now = new Date();

        // Update readAt for messages sent TO this user
        await Message.updateMany(
          {
            _id: { $in: messageIds },
            receiverId: user._id,
          },
          { $set: { readAt: now } }
        );

        // Find the sender (the other user in this 2-person chat)
        const otherUser = await User.findOne({ _id: { $ne: user._id } });
        if (otherUser) {
          const otherUserId = otherUser._id.toString();
          // Emit directly to sender's room so their tick turns green in real time
          io.to(otherUserId).emit('messages_read', {
            messageIds,
            readAt: now,
          });
        }
      } catch (err) {
        console.error('message_read error:', err.message);
      }
    });

    // ─── Message React ────────────────────────────────────────────────────────
    socket.on('message_reacted', (data) => {
      if (!data || !data.messageId) return;
      const { messageId, reactions, receiverId, senderId } = data;
      if (senderId) io.to(senderId.toString()).emit('message_reacted', { messageId, reactions });
      if (receiverId) io.to(receiverId.toString()).emit('message_reacted', { messageId, reactions });
    });

    // ─── Message Delete ───────────────────────────────────────────────────────
    socket.on('message_deleted', (data) => {
      if (!data || !data.messageId) return;
      const { messageId, type, senderId, receiverId } = data;
      if (type === 'everyone') {
        if (senderId) io.to(senderId.toString()).emit('message_deleted', { messageId, type: 'everyone' });
        if (receiverId) io.to(receiverId.toString()).emit('message_deleted', { messageId, type: 'everyone' });
      }
    });
    socket.on('update_profile', async () => {
      try {
        const updatedUser = await User.findById(user._id).select('username displayName profileImage lastSeen');
        if (updatedUser) {
          const otherUser = await User.findOne({ _id: { $ne: user._id } });
          if (otherUser) {
            io.to(otherUser._id.toString()).emit('partner_profile_updated', {
              partner: updatedUser.toSafeObject(),
            });
          }
        }
      } catch (err) {
        console.error('update_profile socket error:', err.message);
      }
    });

    // ─── Theme & Wallpaper Sync ────────────────────────────────────────────────
    socket.on('update_theme', async (data) => {
      try {
        if (!data || !data.theme || !data.motion) return;
        const { theme, motion } = data;

        // Persist theme to database for all users so newly logging in users get it
        await User.updateMany({}, { currentTheme: theme, currentMotion: motion });

        const payload = {
          theme,
          motion,
          updatedBy: user.displayName || user.username,
        };

        // Broadcast to ALL connected clients instantly
        io.emit('theme_updated', payload);
      } catch (err) {
        console.error('update_theme socket error:', err.message);
      }
    });

    // ─── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`🔌 ${user.displayName} disconnected [${socket.id}]`);

      unregisterUser(userId, socket.id);

      // Only broadcast offline if user has no more active sockets
      if (!isUserOnline(userId)) {
        const lastSeen = new Date();

        try {
          await User.findByIdAndUpdate(user._id, { lastSeen });
        } catch (err) {
          console.error('lastSeen update error:', err.message);
        }

        socket.broadcast.emit('user_offline', {
          userId,
          lastSeen,
        });
      }
    });
  });
}

module.exports = { initChatSocket };
