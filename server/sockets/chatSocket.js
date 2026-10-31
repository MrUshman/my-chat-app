'use strict';

/**
 * Chat Socket Handler
 * Manages all real-time Socket.IO events for the private chat.
 */

const Message = require('../models/Message');
const User = require('../models/User');

// Track online users: Map<userIdString, Set<socketId>>
const onlineUsers = new Map();

// Active Call Sessions: Map<callKey, { callerId, calleeId, callType, startedAt, connected, connectedAt, logged }>
const activeCallSessions = new Map();

function getCallKey(id1, id2) {
  if (!id1 || !id2) return '';
  return [id1.toString(), id2.toString()].sort().join('_');
}

async function recordCallMessage(io, session, customStatus = null, durationOverride = null) {
  if (!session || session.logged) return;
  session.logged = true;

  try {
    const callerId = session.callerId;
    const calleeId = session.calleeId;
    const callType = session.callType || 'audio';
    let duration = typeof durationOverride === 'number' ? durationOverride : 0;

    let status = customStatus;
    if (!status) {
      if (session.connected) {
        status = 'completed';
        if (session.connectedAt && duration === 0) {
          duration = Math.max(1, Math.round((Date.now() - session.connectedAt.getTime()) / 1000));
        }
      } else {
        status = 'missed';
      }
    }

    // Build human-readable text
    let text = '';
    if (status === 'completed') {
      text = callType === 'video' ? 'Video call' : 'Voice call';
    } else if (status === 'declined') {
      text = callType === 'video' ? 'Declined video call' : 'Declined voice call';
    } else {
      text = callType === 'video' ? 'Missed video call' : 'Missed voice call';
    }

    const otherOnline = isUserOnline(calleeId, io);
    const now = new Date();

    const callMsg = await Message.create({
      senderId: callerId,
      receiverId: calleeId,
      type: 'call',
      text,
      duration,
      callInfo: {
        callType,
        status,
        duration,
      },
      deliveredAt: otherOnline ? now : null,
    });

    await callMsg.populate('senderId', 'username displayName');
    await callMsg.populate('receiverId', 'username displayName');

    const msgObj = callMsg.toObject();

    io.to(callerId).emit('receive_message', msgObj);
    io.to(calleeId).emit('receive_message', msgObj);

    if (otherOnline) {
      io.to(callerId).emit('message_delivered', {
        messageId: callMsg._id.toString(),
        deliveredAt: now,
      });
    }
  } catch (err) {
    console.error('recordCallMessage error:', err.message);
  }
}

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

function isUserOnline(userId, ioInstance, excludeSocketId = null) {
  if (!userId) return false;
  const uid = userId.toString();

  // 1. Direct validation against live Socket.IO connection map
  if (ioInstance && ioInstance.sockets && ioInstance.sockets.sockets) {
    const activeSocketIds = new Set();
    let hasLiveSocket = false;

    for (const [sId, liveSocket] of ioInstance.sockets.sockets) {
      if (excludeSocketId && sId === excludeSocketId) continue;
      if (liveSocket.connected && liveSocket.user?._id?.toString() === uid) {
        activeSocketIds.add(sId);
        hasLiveSocket = true;
      }
    }

    if (hasLiveSocket) {
      onlineUsers.set(uid, activeSocketIds);
      return true;
    } else {
      onlineUsers.delete(uid);
      return false;
    }
  }

  // 2. Map-based fallback check (only when ioInstance is not provided)
  if (onlineUsers.has(uid)) {
    const socketSet = onlineUsers.get(uid);
    if (excludeSocketId) socketSet.delete(excludeSocketId);
    if (socketSet && socketSet.size > 0) return true;
    onlineUsers.delete(uid);
  }

  return false;
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
        const partnerOnline = isUserOnline(partner._id.toString(), io);
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
        const receiverOnline = isUserOnline(otherUserId, io);

        // Save to MongoDB
        const message = await Message.create({
          senderId: user._id,
          receiverId: otherUser._id,
          type: 'text',
          text: text.trim(),
          deliveredAt: receiverOnline ? now : null,
          replyTo: replyTo || null,
        });

        await message.populate('senderId', 'username displayName');
        await message.populate('receiverId', 'username displayName');
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
          .populate('senderId', 'username displayName')
          .populate('receiverId', 'username displayName')
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
        const receiverOnline = isUserOnline(otherUserId, io);

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
    socket.on('typing_start', async () => {
      try {
        registerUser(userId, socket.id);
        const otherUser = await User.findOne({ _id: { $ne: user._id } }).select('_id');
        if (otherUser) {
          io.to(otherUser._id.toString()).emit('typing_start', {
            userId,
            displayName: user.displayName,
          });
        }
      } catch (err) {
        console.error('typing_start error:', err.message);
      }
    });

    socket.on('typing_stop', async () => {
      try {
        registerUser(userId, socket.id);
        const otherUser = await User.findOne({ _id: { $ne: user._id } }).select('_id');
        if (otherUser) {
          io.to(otherUser._id.toString()).emit('typing_stop', { userId });
        }
      } catch (err) {
        console.error('typing_stop error:', err.message);
      }
    });

    // ─── Message Read ─────────────────────────────────────────────────────────
    socket.on('message_read', async (data) => {
      try {
        if (!data) return;
        const { messageIds } = data;
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;

        const now = new Date();
        const validIds = messageIds.filter(Boolean).map(id => id.toString());

        // Update readAt & deliveredAt for messages sent TO this user
        await Message.updateMany(
          {
            _id: { $in: validIds },
            receiverId: user._id,
          },
          { $set: { readAt: now, deliveredAt: now } }
        );

        // Find the sender (the other user in this 2-person chat)
        const otherUser = await User.findOne({ _id: { $ne: user._id } });
        if (otherUser) {
          const otherUserId = otherUser._id.toString();
          // Emit directly to sender's room so their tick turns emerald green in real time
          io.to(otherUserId).emit('messages_read', {
            messageIds: validIds,
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

    // ─── Explicit Client Online / Visibility Return ────────────────────────
    socket.on('client_online', () => {
      registerUser(userId, socket.id);
      socket.broadcast.emit('user_online', {
        userId,
        displayName: user.displayName,
      });
    });

    // ─── Query Partner Status on Demand (Instant Sync) ─────────────────────
    socket.on('get_partner_status', async () => {
      try {
        const partner = await User.findOne({ _id: { $ne: user._id } }).select('username displayName profileImage lastSeen');
        if (partner) {
          const partnerOnline = isUserOnline(partner._id.toString(), io);
          socket.emit('partner_status', {
            partner: partner.toSafeObject(),
            isOnline: partnerOnline,
            lastSeen: partner.lastSeen,
          });
        }
      } catch (err) {
        console.error('get_partner_status socket error:', err.message);
      }
    });

    // ─── WebRTC Audio & Video Calling Signaling ─────────────────────────────
    socket.on('call_user', async (data, ack) => {
      try {
        const { callType, offer } = data || {};
        const otherUser = await User.findOne({ _id: { $ne: user._id } });
        if (!otherUser) return ack?.({ error: 'Partner not found' });
        const otherUserId = otherUser._id.toString();

        const isOnline = isUserOnline(otherUserId, io);
        if (!isOnline) {
          return ack?.({ error: 'Partner is offline', offline: true });
        }

        const callKey = getCallKey(userId, otherUserId);
        activeCallSessions.set(callKey, {
          callerId: userId,
          calleeId: otherUserId,
          callType: callType || 'audio',
          startedAt: new Date(),
          connected: false,
          connectedAt: null,
          logged: false,
        });

        io.to(otherUserId).emit('incoming_call', {
          callerId: userId,
          callerName: user.displayName || user.username,
          callerAvatar: user.profileImage || null,
          callType: callType || 'audio',
          offer,
        });

        ack?.({ success: true, partnerOnline: true });
      } catch (err) {
        console.error('call_user socket error:', err.message);
        ack?.({ error: 'Call signaling failed' });
      }
    });

    socket.on('call_ringing', (data) => {
      const { callerId } = data || {};
      if (callerId) {
        io.to(callerId).emit('call_ringing');
      } else {
        socket.broadcast.emit('call_ringing');
      }
    });

    socket.on('call_accepted', (data) => {
      const { callerId, answer } = data || {};
      const callKey = getCallKey(userId, callerId);
      const session = activeCallSessions.get(callKey);
      if (session) {
        session.connected = true;
        session.connectedAt = new Date();
      }

      if (callerId) {
        io.to(callerId).emit('call_accepted', { answer });
      } else {
        socket.broadcast.emit('call_accepted', { answer });
      }
    });

    socket.on('call_rejected', (data) => {
      const { callerId, reason } = data || {};
      const callKey = getCallKey(userId, callerId);
      const session = activeCallSessions.get(callKey);
      if (session) {
        const status = reason === 'declined' ? 'declined' : 'missed';
        recordCallMessage(io, session, status, 0);
        activeCallSessions.delete(callKey);
      }

      if (callerId) {
        io.to(callerId).emit('call_rejected', { reason });
      } else {
        socket.broadcast.emit('call_rejected', { reason });
      }
    });

    socket.on('ice_candidate', (data) => {
      const { targetUserId, candidate } = data || {};
      if (targetUserId) {
        io.to(targetUserId).emit('ice_candidate', { candidate });
      } else {
        socket.broadcast.emit('ice_candidate', { candidate });
      }
    });

    socket.on('call_renegotiate', (data) => {
      const { targetUserId, type, sdp } = data || {};
      if (targetUserId) {
        io.to(targetUserId).emit('call_renegotiate', { senderId: userId, type, sdp });
      } else {
        socket.broadcast.emit('call_renegotiate', { senderId: userId, type, sdp });
      }
    });

    socket.on('call_ended', async (data) => {
      const { targetUserId, durationSec, callType } = data || {};
      let otherId = targetUserId;
      if (!otherId) {
        const otherUser = await User.findOne({ _id: { $ne: user._id } });
        if (otherUser) otherId = otherUser._id.toString();
      }

      if (otherId) {
        const callKey = getCallKey(userId, otherId);
        const session = activeCallSessions.get(callKey);
        if (session) {
          const dur = typeof durationSec === 'number' ? durationSec : 0;
          const status = session.connected ? 'completed' : 'missed';
          recordCallMessage(io, session, status, dur);
          activeCallSessions.delete(callKey);
        }
      }

      if (targetUserId) {
        io.to(targetUserId).emit('call_ended', { durationSec, callType });
      } else {
        socket.broadcast.emit('call_ended', { durationSec, callType });
      }
    });

    // ─── Explicit Client Offline Event (on tab close/hide) ───────────────────
    socket.on('client_offline', async () => {
      unregisterUser(userId, socket.id);
      if (!isUserOnline(userId, io, socket.id)) {
        onlineUsers.delete(userId);
        const lastSeen = new Date();
        try {
          await User.findByIdAndUpdate(user._id, { lastSeen });
        } catch (e) {}
        socket.broadcast.emit('user_offline', { userId, lastSeen });
      }
    });

    // ─── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      console.log(`🔌 ${user.displayName} disconnected [${socket.id}] Reason: ${reason}`);

      unregisterUser(userId, socket.id);

      // Record any unclosed call session involving this user
      for (const [key, session] of activeCallSessions.entries()) {
        if (session.callerId === userId || session.calleeId === userId) {
          recordCallMessage(io, session);
          activeCallSessions.delete(key);
        }
      }

      // Only broadcast offline if user has no more active live sockets
      if (!isUserOnline(userId, io, socket.id)) {
        onlineUsers.delete(userId);
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

module.exports = { initChatSocket, isUserOnline, onlineUsers };
