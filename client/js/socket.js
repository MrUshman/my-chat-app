'use strict';

/**
 * socket.js — Socket.IO client connection manager
 * Manages connection, reconnection, and all incoming socket events.
 * Delegates message rendering to Chat module.
 */

const connectionBanner = document.getElementById('connectionBanner');
const connectionBannerText = document.getElementById('connectionBannerText');

let socket = null;
let reconnectAttempts = 0;

function initSocket() {
  const token = localStorage.getItem('chatToken');
  // Connect to same origin (Express serves both frontend and backend)
  socket = io({
    withCredentials: true,
    auth: { token },
    query: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  // ─── Connection Events ────────────────────────────────────────────

  socket.on('connect', () => {
    console.log('🔌 Socket connected:', socket.id);
    reconnectAttempts = 0;
    showConnectionBanner('online', '❤️ Connected');
    // Hide banner after 2s
    setTimeout(() => hideBanner(), 2000);

    // Re-fetch any missed messages on reconnect
    if (window.Chat) {
      window.Chat.onReconnect();
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('🔌 Socket disconnected:', reason);
    if (reason === 'io server disconnect') {
      // Server kicked us — likely auth issue — redirect to login
      window.location.replace('/login.html');
    } else {
      showConnectionBanner('offline', '● Offline');
    }
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connect error:', err.message);
    reconnectAttempts++;
    showConnectionBanner('reconnecting', `⟳ Reconnecting... (${reconnectAttempts})`);
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    reconnectAttempts = attempt;
    showConnectionBanner('reconnecting', `⟳ Reconnecting... (${attempt})`);
  });

  socket.io.on('reconnect', () => {
    showConnectionBanner('online', '❤️ Back online');
    setTimeout(() => hideBanner(), 3000);
  });

  // Re-connect immediately when mobile user returns to tab / unlocks screen
  window.addEventListener('pageshow', () => {
    if (socket && socket.disconnected) {
      socket.connect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket && socket.disconnected) {
      socket.connect();
    }
  });

  // ─── Chat Events ──────────────────────────────────────────────────

  socket.on('receive_message', (message) => {
    if (window.Chat) {
      window.Chat.onReceiveMessage(message);
    }
  });

  socket.on('message_delivered', ({ messageId, deliveredAt }) => {
    if (window.Chat) {
      window.Chat.updateMessageStatus(messageId, 'delivered', deliveredAt);
    }
  });

  socket.on('messages_delivered', ({ messageIds, deliveredAt }) => {
    if (window.Chat) {
      messageIds.forEach(id => window.Chat.updateMessageStatus(id, 'delivered', deliveredAt));
    }
  });

  socket.on('messages_read', ({ messageIds, readAt }) => {
    if (window.Chat && Array.isArray(messageIds)) {
      messageIds.forEach(id => window.Chat.updateMessageStatus(id, 'read', readAt));
    }
  });

  socket.on('message_reacted', ({ messageId, reactions }) => {
    if (window.Chat && window.Chat.updateMessageReactions) {
      window.Chat.updateMessageReactions(messageId, reactions);
    }
  });

  socket.on('message_deleted', ({ messageId, type }) => {
    if (window.Chat && window.Chat.onMessageDeleted) {
      window.Chat.onMessageDeleted(messageId, type);
    }
  });

  // ─── Typing Events ────────────────────────────────────────────────

  socket.on('typing_start', ({ displayName }) => {
    if (window.Chat) window.Chat.showTyping(displayName);
  });

  socket.on('typing_stop', () => {
    if (window.Chat) window.Chat.hideTyping();
  });

  // ─── Presence Events ──────────────────────────────────────────────

  socket.on('partner_status', ({ partner, isOnline, lastSeen }) => {
    if (window.Chat) {
      if (partner) window.Chat.updatePartnerInfo(partner);
      window.Chat.setPartnerOnline(isOnline, lastSeen);
    }
  });

  socket.on('user_online', ({ userId }) => {
    if (window.Chat) window.Chat.setPartnerOnline(true);
  });

  socket.on('user_offline', ({ userId, lastSeen }) => {
    if (window.Chat) window.Chat.setPartnerOnline(false, lastSeen);
  });

  socket.on('theme_updated', ({ theme, motion, updatedBy }) => {
    if (window.Chat && window.Chat.onThemeUpdated) {
      window.Chat.onThemeUpdated(theme, motion, updatedBy);
    }
  });

  return socket;
}

// ─── Connection Banner ────────────────────────────────────────────

function showConnectionBanner(state, text) {
  connectionBanner.className = `connection-banner ${state}`;
  connectionBannerText.textContent = text;
}

function hideBanner() {
  connectionBanner.className = 'connection-banner';
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Send a text message via socket
 */
function sendTextMessage(text, clientMessageId, replyTo) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Not connected'));
      return;
    }

    socket.emit('send_message', { text, clientMessageId, replyTo }, (response) => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Send a media message broadcast (after upload via REST)
 */
function sendMediaMessage(messageId) {
  if (!socket?.connected) {
    UI.showToast('Not connected. Message will appear when reconnected.', 'info');
    return;
  }

  socket.emit('send_media_message', { messageId }, (response) => {
    if (response?.error) {
      console.error('Media broadcast error:', response.error);
    }
  });
}

/**
 * Emit typing start
 */
function emitTypingStart() {
  socket?.emit('typing_start');
}

/**
 * Emit typing stop
 */
function emitTypingStop() {
  socket?.emit('typing_stop');
}

/**
 * Mark messages as read
 */
function emitMessagesRead(messageIds) {
  if (!socket?.connected || !messageIds.length) return;
  socket.emit('message_read', { messageIds });
}

/**
 * Broadcast profile update
 */
function emitProfileUpdate() {
  if (socket?.connected) {
    socket.emit('update_profile');
  }
}

function emitMessageReaction(data) {
  if (socket?.connected) {
    socket.emit('message_reacted', data);
  }
}

function emitMessageDeleted(data) {
  if (socket?.connected) {
    socket.emit('message_deleted', data);
  }
}

function emitThemeUpdate(theme, motion) {
  if (socket?.connected) {
    socket.emit('update_theme', { theme, motion });
  }
}

// Initialize
const socketInstance = initSocket();

window.ChatSocket = {
  sendTextMessage,
  sendMediaMessage,
  emitTypingStart,
  emitTypingStop,
  emitMessagesRead,
  emitProfileUpdate,
  emitMessageReaction,
  emitMessageDeleted,
  emitThemeUpdate,
  get connected() { return socket?.connected || false; },
};
