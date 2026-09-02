'use strict';

/**
 * chat.js — Main chat application logic
 * Handles: auth check, message rendering, pagination, typing indicator,
 *          online/offline status, read receipts, input events.
 */

// ─── DOM References ───────────────────────────────────────────────
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const emptyChat = document.getElementById('emptyChat');
const typingIndicator = document.getElementById('typingIndicator');
const typingText = document.getElementById('typingText');
const partnerName = document.getElementById('partnerName');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const partnerAvatar = document.getElementById('partnerAvatar');

// ─── State ────────────────────────────────────────────────────────
let currentUser = null;
let partner = null;
let renderedMessageIds = new Set();   // For dedup
let oldestMessageId = null;           // For pagination
let hasMoreMessages = false;
let typingTimeout = null;
let isTyping = false;
let isLoadingMessages = false;
let unreadMessageIds = [];            // Accumulate before sending read receipt

let activePartnerId = null;
let lastMessageSnippet = '';

// ─── Init ─────────────────────────────────────────────────────────

function getAuthHeaders(existingHeaders = {}) {
  const token = localStorage.getItem('chatToken');
  if (token) {
    existingHeaders['Authorization'] = `Bearer ${token}`;
  }
  return existingHeaders;
}
window.getAuthHeaders = getAuthHeaders;

// ─── Instant Cache Hydration (0ms WhatsApp-style Stale-While-Revalidate) ───

function applyCachedState() {
  try {
    const cachedUser = localStorage.getItem('cached_user');
    const cachedPartner = localStorage.getItem('cached_partner');
    const cachedTheme = localStorage.getItem('chat_theme') || 'purple';
    const cachedMotion = localStorage.getItem('chat_motion') || 'floating-hearts';
    const cachedMessages = localStorage.getItem('cached_messages');

    // Instantly apply theme
    applyThemeAndMotion(cachedTheme, cachedMotion);

    // Instantly populate current user profile
    if (cachedUser) {
      currentUser = JSON.parse(cachedUser);
      updateMyProfileUI();
    }

    // Instantly populate partner profile
    if (cachedPartner) {
      partner = JSON.parse(cachedPartner);
      updatePartnerInfo(partner);
    }

    // Instantly render last 20 messages with 0ms blank screen (filtering out >48h)
    if (cachedMessages) {
      const messages = JSON.parse(cachedMessages);
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const validMessages = Array.isArray(messages) ? messages.filter(m => new Date(m.createdAt).getTime() >= cutoff) : [];

      if (validMessages.length > 0) {
        emptyChat.style.display = 'none';
        for (const msg of validMessages) {
          renderMessage(msg, 'append');
        }
        scrollToBottom(false);
      }
    }
  } catch (e) {
    console.warn('Cache hydration skipped:', e);
  }
}

function saveMessagesToCache(messages) {
  try {
    if (Array.isArray(messages) && messages.length > 0) {
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      // Only keep messages within 48h (max 25)
      const valid = messages.filter(m => new Date(m.createdAt).getTime() >= cutoff).slice(-25);
      localStorage.setItem('cached_messages', JSON.stringify(valid));
    }
  } catch (e) {}
}

async function init() {
  // 1. Instant Synchronous Render (0ms perceived load)
  applyCachedState();

  // Setup UI listeners immediately so interaction is instant
  setupInputEvents();
  setupSettingsAndProfile();
  setupThemeCustomizer();
  setupDeleteModalListeners();
  setupReplyListeners();
  setupInChatSearch();
  setupScrollObserver();
  setupMobileBackButtonHandling();

  // 2. Parallel Network Fetch (cuts network wait time by 50%)
  try {
    const [authRes, messagesRes] = await Promise.all([
      fetch('/api/auth/me', { credentials: 'include', headers: getAuthHeaders() }),
      fetch('/api/messages?limit=20', { credentials: 'include', headers: getAuthHeaders() }),
    ]);

    if (!authRes.ok) {
      window.location.replace('/login.html');
      return;
    }

    const { user, partner: partnerUser } = await authRes.json();
    currentUser = user;
    localStorage.setItem('cached_user', JSON.stringify(user));
    updateMyProfileUI();

    // Sync theme with server
    const activeTheme = user.currentTheme || localStorage.getItem('chat_theme') || 'purple';
    const activeMotion = user.currentMotion || localStorage.getItem('chat_motion') || 'floating-hearts';
    applyThemeAndMotion(activeTheme, activeMotion);
    localStorage.setItem('chat_theme', activeTheme);
    localStorage.setItem('chat_motion', activeMotion);

    if (partnerUser) {
      updatePartnerInfo(partnerUser);
      localStorage.setItem('cached_partner', JSON.stringify(partnerUser));
    }

    // Sync messages
    if (messagesRes.ok) {
      const { messages, hasMore } = await messagesRes.json();
      hasMoreMessages = hasMore;
      loadMoreBtn.style.display = hasMore ? 'flex' : 'none';

      if (messages.length === 0 && renderedMessageIds.size === 0) {
        emptyChat.style.display = 'flex';
      } else if (messages.length > 0) {
        emptyChat.style.display = 'none';
        for (const msg of messages) {
          renderMessage(msg, 'append');
        }
        oldestMessageId = messages[0]._id;
        saveMessagesToCache(messages);
        scrollToBottom(false);
      }
    }

  } catch (err) {
    console.error('Init parallel fetch error:', err);
    // If offline but cache rendered, let user stay in chat!
    if (!currentUser) {
      UI.showToast('Failed to connect to chat. Please refresh.', 'error');
    }
  }
}

// ─── View Screen Navigation ──────────────────────────────────────

function selectConversation(partnerId) {
  activePartnerId = partnerId;
  const chatsListView = document.getElementById('chatsListView');
  const activeChatView = document.getElementById('activeChatView');

  if (chatsListView) chatsListView.style.display = 'none';
  if (activeChatView) activeChatView.style.display = 'flex';

  scrollToBottom(false);
}

function showChatsList() {
  const chatsListView = document.getElementById('chatsListView');
  const activeChatView = document.getElementById('activeChatView');

  if (activeChatView) activeChatView.style.display = 'none';
  if (chatsListView) chatsListView.style.display = 'flex';
}

// ─── Load Partner Info ────────────────────────────────────────────

async function loadPartnerInfo() {
  try {
    const res = await fetch('/api/auth/partner', { credentials: 'include', headers: getAuthHeaders() });
    if (res.ok) {
      const { partner: p } = await res.json();
      if (p) updatePartnerInfo(p);
    }
  } catch (err) {
    console.error('loadPartnerInfo error:', err);
  }
}

// ─── Load Messages (paginated) ────────────────────────────────────

async function loadMessages(before = null) {
  if (isLoadingMessages) return;
  isLoadingMessages = true;
  if (loadMoreBtn) {
    loadMoreBtn.classList.add('loading');
    const textEl = loadMoreBtn.querySelector('.load-more-text');
    if (textEl) textEl.textContent = 'Loading earlier messages...';
  }

  try {
    let url = '/api/messages?limit=20';
    if (before) url += `&before=${before}`;

    const res = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to load messages');

    const { messages, hasMore } = await res.json();

    hasMoreMessages = hasMore;
    loadMoreBtn.style.display = hasMore ? 'flex' : 'none';

    if (messages.length === 0 && !before) {
      emptyChat.style.display = 'flex';
      return;
    }

    emptyChat.style.display = 'none';

    // Save scroll position before prepending messages
    const prevScrollHeight = chatMessages.scrollHeight;

    // Render messages
    for (const msg of messages) {
      renderMessage(msg, before ? 'prepend' : 'append');
    }

    if (before) {
      // Maintain scroll position after prepending
      chatMessages.scrollTop = chatMessages.scrollHeight - prevScrollHeight;
    }

    // Track oldest message for pagination
    if (messages.length > 0) {
      oldestMessageId = messages[0]._id;
      if (!before) {
        saveMessagesToCache(messages);
      }
    }

    // Discover partner from messages
    for (const msg of messages) {
      const senderObj = msg.senderId;
      const receiverObj = msg.receiverId;
      if (senderObj && senderObj._id !== currentUser._id) {
        updatePartnerInfo(senderObj);
        break;
      }
      if (receiverObj && receiverObj._id !== currentUser._id) {
        updatePartnerInfo(receiverObj);
        break;
      }
    }

  } catch (err) {
    console.error('loadMessages error:', err);
    UI.showToast('Could not load messages.', 'error');
  } finally {
    isLoadingMessages = false;
    if (loadMoreBtn) {
      loadMoreBtn.classList.remove('loading');
      const textEl = loadMoreBtn.querySelector('.load-more-text');
      if (textEl) textEl.textContent = 'Load older messages';
    }
  }
}

// ─── Update Current User Profile UI ──────────────────────────────

function updateMyProfileUI() {
  if (!currentUser) return;
  const myNameEl = document.getElementById('myName');
  const myUsernameEl = document.getElementById('myUsername');
  const myAvatarEl = document.getElementById('myAvatar');

  if (myNameEl) myNameEl.textContent = currentUser.displayName || 'My Account';
  if (myUsernameEl) myUsernameEl.textContent = `@${currentUser.username || ''}`;

  if (myAvatarEl) {
    if (currentUser.profileImage) {
      myAvatarEl.innerHTML = `<img src="${currentUser.profileImage}" alt="${currentUser.displayName}" />`;
    } else {
      myAvatarEl.textContent = (currentUser.displayName || 'U').charAt(0).toUpperCase();
    }
  }
}

// ─── Render Chats List Screen ────────────────────────────────────

function renderChatsList() {
  const chatsList = document.getElementById('chatsList');
  if (!chatsList || !partner) return;

  const initial = (partner.displayName || 'P').charAt(0).toUpperCase();
  const avatarHtml = partner.profileImage
    ? `<img src="${partner.profileImage}" alt="${partner.displayName}" />`
    : initial;

  const isPartnerOnline = statusDot.classList.contains('online');
  const lastMsgText = lastMessageSnippet || 'Tap to start chatting ❤️';

  chatsList.innerHTML = `
    <div class="chat-item ${activePartnerId === partner._id ? 'active' : ''}" id="chatItem-${partner._id}" onclick="selectConversation('${partner._id}')">
      <div class="chat-item-avatar-wrapper">
        <div class="chat-item-avatar">${avatarHtml}</div>
        <span class="chat-item-status-dot ${isPartnerOnline ? 'online' : ''}" id="chatItemStatus-${partner._id}"></span>
      </div>
      <div class="chat-item-content">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(partner.displayName)}</span>
          <span class="chat-item-time" id="chatItemTime-${partner._id}">Active</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-preview" id="chatItemPreview-${partner._id}">${escapeHtml(lastMsgText)}</span>
        </div>
      </div>
    </div>
  `;
}

function updatePartnerInfo(user) {
  if (!user) return;
  partner = user;
  renderChatsList();
  if (partnerName) partnerName.textContent = user.displayName;
  document.title = `Chat with ${user.displayName} ❤️`;

  const avatarEl = document.getElementById('partnerAvatar');
  if (avatarEl) {
    if (user.profileImage) {
      avatarEl.className = 'header-avatar';
      avatarEl.innerHTML = `<img src="${user.profileImage}" alt="${user.displayName}" />`;
    } else {
      avatarEl.className = 'header-avatar-placeholder';
      avatarEl.textContent = user.displayName.charAt(0).toUpperCase();
    }
  }
}

// ─── Render a Single Message ──────────────────────────────────────

function renderMessage(msg, position = 'append') {
  // Dedup check
  if (renderedMessageIds.has(msg._id)) return;
  renderedMessageIds.add(msg._id);

  // Normalize IDs to strings for safe comparison (MongoDB ObjectId vs string)
  const senderIdStr = (msg.senderId?._id || msg.senderId)?.toString();
  const currentUserIdStr = currentUser?._id?.toString();
  const isMe = senderIdStr === currentUserIdStr;

  // Discover partner info (safe string comparison)
  if (!partner) {
    const receiverIdStr = (msg.receiverId?._id || msg.receiverId)?.toString();
    if (!isMe && msg.senderId?.displayName) {
      updatePartnerInfo(msg.senderId);
    } else if (receiverIdStr && receiverIdStr !== currentUserIdStr && msg.receiverId?.displayName) {
      updatePartnerInfo(msg.receiverId);
    }
  }

  // Check if previous message is from same sender (grouping)
  const allMsgWrappers = chatMessages.querySelectorAll('.message-wrapper');
  const lastMsgEl = allMsgWrappers[allMsgWrappers.length - 1];
  const isGrouped = lastMsgEl &&
    lastMsgEl.dataset.sender === (isMe ? 'me' : 'them') &&
    (new Date(msg.createdAt) - new Date(lastMsgEl.dataset.time)) < 60000;

  // Date separator — only append, avoid duplicates
  if (position === 'append') {
    const msgDate = UI.formatDateLabel(msg.createdAt);
    const allSeparators = chatMessages.querySelectorAll('.date-separator');
    const lastSepDate = allSeparators[allSeparators.length - 1]?.dataset.date;
    if (msgDate !== lastSepDate) {
      chatMessages.appendChild(createDateSeparator(msgDate));
    }
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${isMe ? 'me' : 'them'}${isGrouped ? ' grouped' : ''}`;
  wrapper.dataset.messageId = msg._id;
  wrapper.dataset.sender = isMe ? 'me' : 'them';
  wrapper.dataset.time = msg.createdAt;
  if (isSelectionMode && selectedMessageIds.has(msg._id)) {
    wrapper.classList.add('selected');
  }

  // Check if message was deleted for everyone
  if (msg.deletedForEveryone) {
    wrapper.innerHTML = `
      <div class="message-bubble deleted-message-text">🚫 This message was deleted</div>
      <div class="message-meta">
        <span class="message-time">${UI.formatTime(msg.createdAt)}</span>
      </div>
    `;
    if (position === 'append') {
      chatMessages.appendChild(wrapper);
    } else {
      chatMessages.insertBefore(wrapper, loadMoreBtn.nextSibling);
    }
    return;
  }

  // Build bubble content based on type
  let bubbleContent = '';

  if (msg.type === 'text') {
    bubbleContent = `<div class="message-bubble">${escapeHtml(msg.text)}</div>`;
  } else if (msg.type === 'image') {
    if (msg.mediaDeleted) {
      bubbleContent = `<div class="image-expired-notice">📷 Photo expired and was deleted</div>`;
    } else {
      bubbleContent = `
        <div class="image-message message-bubble" style="padding:4px;"
             onclick="UI.openImageModal('${msg.mediaUrl}', 'photo.jpg')"
             role="button" tabindex="0" aria-label="View photo">
          <img src="${msg.mediaUrl}" alt="Sent photo" loading="lazy"
               onerror="this.parentElement.outerHTML='<div class=\\'image-expired-notice\\'>📷 Photo expired</div>'" />
          <div class="image-overlay-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
          </div>
        </div>`;
    }
  } else if (msg.type === 'audio') {
    if (msg.mediaDeleted) {
      bubbleContent = `<div class="image-expired-notice">🎙️ Voice message expired and was deleted</div>`;
    } else {
      bubbleContent = `
        <div class="audio-message message-bubble" id="audio-container-${msg._id}">
          <audio controls preload="auto" src="${msg.mediaUrl}" class="chat-audio-player"></audio>
          <button class="audio-speed-btn" onclick="toggleAudioSpeed(this)" type="button" title="Audio Speed">1x</button>
          <a class="audio-download-btn" href="${msg.mediaUrl}?download=true" download="voice-message" title="Download" aria-label="Download voice message">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </a>
        </div>`;
    }
  }

  // Status icon (only for my messages)
  let statusHtml = '';
  if (isMe) {
    const statusClass = msg.readAt ? 'read' : msg.deliveredAt ? 'delivered' : 'sent';
    const checkmarks = (msg.readAt || msg.deliveredAt) ? DOUBLE_TICK_SVG : SINGLE_TICK_SVG;
    statusHtml = `<span class="message-status ${statusClass}" id="status-${msg._id}">${checkmarks}</span>`;
  }

  // Build Quoted Reply Card if message was sent as a reply
  let quotedCardHtml = '';
  if (msg.replyTo) {
    const rMsg = msg.replyTo;
    const rSenderName = rMsg.senderId?.displayName || rMsg.senderId?.username || 'User';
    const rSnippet = rMsg.deletedForEveryone ? '🚫 Message deleted' : (rMsg.text || (rMsg.type === 'image' ? '📷 Photo' : '🎙️ Voice message'));
    quotedCardHtml = `
      <div class="quoted-message-card" data-reply-id="${rMsg._id || ''}">
        <span class="quoted-sender-name">${escapeHtml(rSenderName)}</span>
        <span class="quoted-snippet-text">${escapeHtml(rSnippet)}</span>
      </div>`;
  }

  wrapper.innerHTML = `
    <span class="reply-swipe-indicator">↩️</span>
    ${quotedCardHtml}
    ${bubbleContent}
    <div class="message-meta">
      <span class="message-time">${UI.formatTime(msg.createdAt)}</span>
      ${statusHtml}
    </div>
  `;

  if (position === 'append') {
    chatMessages.appendChild(wrapper);
  } else {
    // Prepend — insert after load more button
    const ref = loadMoreBtn.nextSibling;
    chatMessages.insertBefore(wrapper, ref);
  }

  // Track unread incoming messages
  if (!isMe && !msg.readAt) {
    unreadMessageIds.push(msg._id);
  }

  emptyChat.style.display = 'none';
}

function createDateSeparator(label) {
  const sep = document.createElement('div');
  sep.className = 'date-separator';
  sep.dataset.date = label;
  sep.innerHTML = `<span class="date-separator-label">${escapeHtml(label)}</span>`;
  return sep;
}

// ─── Audio Player Controls ────────────────────────────────────────

const PLAY_SVG = `<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
const PAUSE_SVG = `<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;

function toggleAudio(audioId, progressId, durationId, btn) {
  const audio = document.getElementById(audioId);
  if (!audio) return;

  const container = btn.closest('.audio-message');

  if (audio.paused) {
    // Pause any other playing audio
    document.querySelectorAll('audio').forEach(a => {
      if (a !== audio && !a.paused) {
        a.pause();
        const otherBtn = a.parentElement?.querySelector('.audio-play-btn');
        if (otherBtn) otherBtn.innerHTML = PLAY_SVG;
        a.parentElement?.closest('.audio-message')?.classList.remove('is-playing');
      }
    });

    audio.play();
    btn.innerHTML = PAUSE_SVG;
    if (container) container.classList.add('is-playing');

    audio.ontimeupdate = () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      const fill = document.getElementById(progressId);
      const dur = document.getElementById(durationId);
      if (fill) fill.style.width = pct + '%';
      if (dur) dur.textContent = UI.formatDuration(audio.currentTime);
    };

    audio.onended = () => {
      btn.innerHTML = PLAY_SVG;
      if (container) container.classList.remove('is-playing');
      const fill = document.getElementById(progressId);
      const dur = document.getElementById(durationId);
      if (fill) fill.style.width = '0%';
      if (dur) dur.textContent = UI.formatDuration(audio.duration);
    };
  } else {
    audio.pause();
    btn.innerHTML = PLAY_SVG;
    if (container) container.classList.remove('is-playing');
  }
}

function seekAudio(event, audioId, progressId, durationId) {
  const audio = document.getElementById(audioId);
  if (!audio || !audio.duration) return;
  const bar = event.currentTarget;
  const rect = bar.getBoundingClientRect();
  const pct = (event.clientX - rect.left) / rect.width;
  audio.currentTime = pct * audio.duration;
}

function toggleAudioSpeed(btn) {
  const container = btn.closest('.audio-message');
  const audio = container?.querySelector('audio');
  if (!audio) return;

  const currentRate = audio.playbackRate || 1.0;
  let nextRate = 1.0;
  if (currentRate === 1.0) nextRate = 1.5;
  else if (currentRate === 1.5) nextRate = 2.0;
  else nextRate = 1.0;

  audio.playbackRate = nextRate;
  btn.textContent = `${nextRate}x`;
  btn.classList.toggle('active', nextRate > 1.0);
}

// Make these globally accessible (used in inline onclick handlers)
window.toggleAudio = toggleAudio;
window.seekAudio = seekAudio;
window.toggleAudioSpeed = toggleAudioSpeed;

// ─── Send Message ─────────────────────────────────────────────────

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  // Clear input immediately for better UX
  messageInput.value = '';
  messageInput.style.height = 'auto';
  updateSendButton();
  stopTyping();

  const replyToId = currentReplyTarget?.id || null;
  const replyTargetObj = currentReplyTarget ? { ...currentReplyTarget } : null;
  cancelReplyPreview();

  // Generate a client-side ID to prevent duplicate rendering
  const clientMessageId = `client-${Date.now()}-${Math.random()}`;

  // Optimistic UI: render the message immediately
  const optimisticMsg = {
    _id: clientMessageId,
    senderId: { _id: currentUser._id, displayName: currentUser.displayName },
    receiverId: partner ? { _id: partner._id, displayName: partner.displayName } : {},
    type: 'text',
    text,
    replyTo: replyTargetObj ? {
      _id: replyTargetObj.id,
      text: replyTargetObj.textSnippet,
      senderId: { displayName: replyTargetObj.senderName },
    } : null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
  };
  renderMessage(optimisticMsg, 'append');
  scrollToBottom();

  try {
    const response = await window.ChatSocket.sendTextMessage(text, clientMessageId, replyToId);

    if (response?.messageId) {
      // Replace optimistic message ID with real one
      const wrapper = chatMessages.querySelector(`[data-message-id="${clientMessageId}"]`);
      if (wrapper) {
        wrapper.dataset.messageId = response.messageId;
        renderedMessageIds.delete(clientMessageId);
        renderedMessageIds.add(response.messageId);
      }
    }
  } catch (err) {
    UI.showToast('Message failed to send. ' + err.message, 'error');
    // Remove optimistic message
    const wrapper = chatMessages.querySelector(`[data-message-id="${clientMessageId}"]`);
    if (wrapper) wrapper.remove();
    renderedMessageIds.delete(clientMessageId);
    // Restore input
    messageInput.value = text;
    updateSendButton();
  }
}

// ─── Receive Message ──────────────────────────────────────────────

function onReceiveMessage(msg) {
  // Dedup: if we already rendered this (optimistic), update its ID and skip
  if (renderedMessageIds.has(msg._id)) return;

  // Check if it was an optimistic message from us
  if (msg.clientMessageId) {
    const optimisticEl = chatMessages.querySelector(`[data-message-id="${msg.clientMessageId}"]`);
    if (optimisticEl) {
      optimisticEl.dataset.messageId = msg._id;
      renderedMessageIds.delete(msg.clientMessageId);
      renderedMessageIds.add(msg._id);
      return;
    }
  }

  const isMe = msg.senderId._id === currentUser._id || msg.senderId === currentUser._id;

  // Discover partner if needed
  if (!isMe && !partner) {
    updatePartnerInfo(msg.senderId);
  }

  renderMessage(msg, 'append');
  scrollToBottom();

  // If receiver, mark as read (we're viewing the chat)
  if (!isMe) {
    unreadMessageIds.push(msg._id);
    sendReadReceipts();

    // Browser notification (when tab is not focused)
    const senderName = msg.senderId.displayName || 'Someone';
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`${senderName} ❤️`, {
        body: msg.type === 'text' ? msg.text : msg.type === 'image' ? '📷 Photo' : '🎙️ Voice message',
        icon: '/favicon.ico',
      });
      setTimeout(() => n.close(), 5000);
    }
  }
}

// ─── Read Receipts ────────────────────────────────────────────────

function sendReadReceipts() {
  if (unreadMessageIds.length === 0) return;
  const toRead = [...unreadMessageIds];
  unreadMessageIds = [];
  window.ChatSocket.emitMessagesRead(toRead);
}

function setupScrollObserver() {
  // Send read receipts when user is viewing the chat
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && unreadMessageIds.length > 0) {
      sendReadReceipts();
    }
  });
}

const SINGLE_TICK_SVG = `<svg class="status-ticks-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>`;
const DOUBLE_TICK_SVG = `<svg class="status-ticks-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L7 17l-5-5"></path><path d="M22 10l-7.5 7.5"></path></svg>`;

// ─── Update Message Status ────────────────────────────────────────

function updateMessageStatus(messageId, status, time) {
  const statusEl = document.getElementById(`status-${messageId}`);
  if (!statusEl) return;

  if (status === 'delivered') {
    statusEl.className = 'message-status delivered';
    statusEl.innerHTML = DOUBLE_TICK_SVG;
  } else if (status === 'read') {
    statusEl.className = 'message-status read';
    statusEl.innerHTML = DOUBLE_TICK_SVG;
  } else if (status === 'sent') {
    statusEl.className = 'message-status sent';
    statusEl.innerHTML = SINGLE_TICK_SVG;
  }
}

// ─── Online/Offline Status ────────────────────────────────────────

function setPartnerOnline(online, lastSeen = null) {
  if (online) {
    statusDot.classList.add('online');
    statusText.textContent = 'Online';
    statusText.classList.add('online');
  } else {
    statusDot.classList.remove('online');
    statusText.textContent = UI.formatLastSeen(lastSeen);
    statusText.classList.remove('online');
  }
}

// ─── Typing Indicator ─────────────────────────────────────────────

function showTyping(displayName) {
  typingText.textContent = `${displayName} is typing...`;
  typingIndicator.classList.add('visible');
  scrollToBottom();
}

function hideTyping() {
  typingIndicator.classList.remove('visible');
}

// ─── Input Events ─────────────────────────────────────────────────

function setupInputEvents() {
  // Auto-resize textarea & immediate send button toggle across all input/key/composition events
  ['input', 'beforeinput', 'keyup', 'keydown', 'change', 'paste', 'cut', 'focus', 'compositionstart', 'compositionupdate', 'compositionend'].forEach(evt => {
    messageInput.addEventListener(evt, () => {
      UI.autoResize(messageInput);
      updateSendButton();
      handleTyping();
    });
  });

  // Send on Enter (Shift+Enter = new line)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (messageInput.value.trim()) sendMessage();
    }
  });

  // Send button click & touch handlers
  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sendMessage();
  });
  sendBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    sendMessage();
  });

  // Mobile Keyboard gap & viewport adjustment
  messageInput.addEventListener('focus', () => {
    document.body.classList.add('keyboard-open');
    const inputArea = document.getElementById('chatInputArea');
    if (inputArea) inputArea.classList.add('keyboard-open');
    updateSendButton();
    setTimeout(() => scrollToBottom(false), 200);
  });

  messageInput.addEventListener('blur', () => {
    document.body.classList.remove('keyboard-open');
    const inputArea = document.getElementById('chatInputArea');
    if (inputArea) inputArea.classList.remove('keyboard-open');
    setTimeout(updateSendButton, 120);
  });

  // Initialize send button state
  updateSendButton();

  logoutBtn.addEventListener('click', logout);

  loadMoreBtn.addEventListener('click', () => {
    if (oldestMessageId) {
      loadMessages(oldestMessageId);
    }
  });

  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ─── Settings & Profile Handlers ─────────────────────────────────

const settingsBtn = document.getElementById('settingsBtn');
const settingsDropdown = document.getElementById('settingsDropdown');
const profileMenuBtn = document.getElementById('profileMenuBtn');
const profileModal = document.getElementById('profileModal');
const profileModalClose = document.getElementById('profileModalClose');
const profileCancelBtn = document.getElementById('profileCancelBtn');
const profileForm = document.getElementById('profileForm');
const profileAvatarDisplay = document.getElementById('profileAvatarDisplay');
const avatarUploadBtn = document.getElementById('avatarUploadBtn');
const avatarFileInput = document.getElementById('avatarFileInput');
const profileDisplayNameInput = document.getElementById('profileDisplayNameInput');
const profileUsernameInput = document.getElementById('profileUsernameInput');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const saveProfileBtnText = document.getElementById('saveProfileBtnText');

let selectedAvatarFile = null;
let isSettingsSetupDone = false;

function setupSettingsAndProfile() {
  if (isSettingsSetupDone) return;
  const sBtn = document.getElementById('settingsBtn');
  const sDropdown = document.getElementById('settingsDropdown');
  if (!sBtn || !sDropdown) return;
  isSettingsSetupDone = true;

  // Initialize Theme Customizer & Delete Modal
  setupThemeCustomizer();
  setupDeleteModalListeners();

  // Toggle settings dropdown — suppress reaction bar ONLY while 3-dot menu is open
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = settingsDropdown.style.display === 'block';
    const nextState = !isVisible;
    settingsDropdown.style.display = nextState ? 'block' : 'none';
    settingsBtn.classList.toggle('active', nextState);
    document.body.classList.toggle('menu-open', nextState);
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (settingsDropdown && !settingsDropdown.contains(e.target) && !settingsBtn.contains(e.target)) {
      settingsDropdown.style.display = 'none';
      settingsBtn.classList.remove('active');
      document.body.classList.remove('menu-open');
    }
  });

  // Event delegation for chat messages (photos & delete)
  chatMessages.addEventListener('click', (e) => {

    // 2. Photo click for full-screen viewer
    const imgMsg = e.target.closest('.image-message');
    if (imgMsg) {
      const img = imgMsg.querySelector('img');
      if (img && img.src) {
        UI.openImageModal(img.src, 'chat-photo.jpg');
      }
      return;
    }

    // 3. Delete trash button click
    const deleteBtn = e.target.closest('.msg-delete-btn');
    if (deleteBtn) {
      e.stopPropagation();
      const wrapper = deleteBtn.closest('.message-wrapper');
      const messageId = wrapper?.dataset.messageId;
      const isMe = wrapper?.dataset.sender === 'me';
      if (messageId) {
        openDeleteModal(messageId, isMe);
      }
    }
  });

  // Open profile modal
  profileMenuBtn?.addEventListener('click', () => {
    settingsDropdown.style.display = 'none';
    settingsBtn.classList.remove('active');
    openProfileModal();
  });

  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  logoutBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    settingsDropdown.style.display = 'none';
    settingsBtn.classList.remove('active');
    logout();
  });

  // Close profile modal
  profileModalClose?.addEventListener('click', closeProfileModal);
  profileCancelBtn?.addEventListener('click', closeProfileModal);
  profileModal?.addEventListener('click', (e) => {
    if (e.target === profileModal) closeProfileModal();
  });

  // Avatar upload badge trigger
  avatarUploadBtn?.addEventListener('click', () => {
    avatarFileInput.click();
  });

  // Avatar file selection preview
  avatarFileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      UI.showToast('Please select a valid image (JPG, PNG, or WEBP).', 'error');
      return;
    }

    selectedAvatarFile = file;
    const reader = new FileReader();
    reader.onload = (evt) => {
      profileAvatarDisplay.innerHTML = `<img src="${evt.target.result}" alt="Profile avatar" />`;
    };
    reader.readAsDataURL(file);
  });

  // Save profile submission
  profileForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = profileDisplayNameInput.value.trim();
    if (!newName) {
      UI.showToast('Please enter a display name.', 'error');
      return;
    }

    saveProfileBtn.disabled = true;
    saveProfileBtnText.textContent = 'Saving...';

    try {
      const formData = new FormData();
      formData.append('displayName', newName);
      if (selectedAvatarFile) {
        formData.append('avatar', selectedAvatarFile);
      }

      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.user) {
        currentUser = data.user;
        UI.showToast('Profile updated successfully!', 'success');

        // Broadcast profile update via socket to partner
        window.ChatSocket.emitProfileUpdate();

        closeProfileModal();
      } else {
        UI.showToast(data.error || 'Failed to update profile.', 'error');
      }
    } catch (err) {
      console.error('Profile update error:', err);
      UI.showToast('Failed to update profile. Please try again.', 'error');
    } finally {
      saveProfileBtn.disabled = false;
      saveProfileBtnText.textContent = 'Save Changes';
    }
  });
}

function openProfileModal() {
  if (!currentUser) return;
  selectedAvatarFile = null;
  profileDisplayNameInput.value = currentUser.displayName || '';
  profileUsernameInput.value = `@${currentUser.username || ''}`;

  if (currentUser.profileImage) {
    profileAvatarDisplay.innerHTML = `<img src="${currentUser.profileImage}" alt="${currentUser.displayName}" />`;
  } else {
    profileAvatarDisplay.textContent = (currentUser.displayName || 'U').charAt(0).toUpperCase();
  }

  profileModal.style.display = 'flex';
}

function closeProfileModal() {
  profileModal.style.display = 'none';
  selectedAvatarFile = null;
}

function updateSendButton() {
  const text = (messageInput && messageInput.value) || '';
  const hasContent = text.trim().length > 0;

  const micBtn = document.getElementById('micBtn');
  const inputRow = document.querySelector('.input-row');

  if (hasContent) {
    // Typing active / has text -> SHOW SEND BUTTON, HIDE RECORD BUTTON
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.setProperty('display', 'flex', 'important');
      sendBtn.style.setProperty('visibility', 'visible', 'important');
      sendBtn.style.setProperty('opacity', '1', 'important');
      sendBtn.classList.add('has-content');
    }
    if (micBtn) {
      micBtn.style.setProperty('display', 'none', 'important');
      micBtn.style.setProperty('visibility', 'hidden', 'important');
    }
    if (inputRow) inputRow.classList.add('has-text');
  } else {
    // No text / empty -> SHOW RECORD BUTTON, HIDE SEND BUTTON
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.style.setProperty('display', 'none', 'important');
      sendBtn.style.setProperty('visibility', 'hidden', 'important');
      sendBtn.classList.remove('has-content');
    }
    if (micBtn) {
      micBtn.style.setProperty('display', 'flex', 'important');
      micBtn.style.setProperty('visibility', 'visible', 'important');
    }
    if (inputRow) inputRow.classList.remove('has-text');
  }
}

// ─── Typing Events ────────────────────────────────────────────────

function handleTyping() {
  if (!isTyping) {
    isTyping = true;
    window.ChatSocket.emitTypingStart();
  }

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTyping, 2000);
}

function stopTyping() {
  if (isTyping) {
    isTyping = false;
    window.ChatSocket.emitTypingStop();
  }
  clearTimeout(typingTimeout);
}

// ─── Reconnect ────────────────────────────────────────────────────

async function onReconnect() {
  // Re-fetch recent messages to catch any missed while offline
  // We only load new messages (don't clear existing)
  // Simple approach: reload last page and dedup via renderedMessageIds
  try {
    const res = await fetch('/api/messages?limit=20', { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) return;

    const { messages } = await res.json();
    for (const msg of messages) {
      renderMessage(msg, 'append');
    }
    scrollToBottom();
  } catch (err) {
    console.error('Reconnect re-fetch error:', err);
  }
}

// ─── Scroll ───────────────────────────────────────────────────────

function scrollToBottom(smooth = true) {
  chatMessages.scrollTo({
    top: chatMessages.scrollHeight,
    behavior: smooth ? 'smooth' : 'instant',
  });
}

// ─── Logout ───────────────────────────────────────────────────────

async function logout() {
  try {
    const token = localStorage.getItem('chatToken');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers,
    });
  } catch {}

  // Explicitly clear token from localStorage and cookie
  localStorage.removeItem('chatToken');
  document.cookie = 'chatToken=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0; SameSite=Lax';

  // Disconnect socket if connected
  if (socket && typeof socket.disconnect === 'function') {
    socket.disconnect();
  }

  window.location.replace('/login.html?logout=true');
}

// ─── Helpers ─────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Audio Player Handlers ────────────────────────────────────────

let currentAudioPlayer = null;
let currentPlayingUrl = null;
let currentPlayingBtn = null;

function toggleAudio(mediaUrl, progressId, durationId, btn) {
  const progressFill = document.getElementById(progressId);
  const durationEl = document.getElementById(durationId);

  // If clicking the currently playing audio
  if (currentAudioPlayer && currentPlayingUrl === mediaUrl) {
    if (!currentAudioPlayer.paused) {
      currentAudioPlayer.pause();
      btn.innerHTML = `<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
      return;
    } else {
      currentAudioPlayer.play().then(() => {
        btn.innerHTML = `<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
      }).catch((err) => {
        console.error('Audio play error:', err);
        UI.showToast('Could not play audio message.', 'error');
      });
      return;
    }
  }

  // If another audio was playing, stop it first
  if (currentAudioPlayer) {
    currentAudioPlayer.pause();
    if (currentPlayingBtn) {
      currentPlayingBtn.innerHTML = `<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    }
  }

  // Create fresh Audio instance for this mediaUrl
  const audio = new Audio(mediaUrl);
  audio.volume = 1.0;
  audio.muted = false;

  const startPlay = () => {
    audio.play().then(() => {
      currentAudioPlayer = audio;
      currentPlayingUrl = mediaUrl;
      currentPlayingBtn = btn;
      btn.innerHTML = `<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
    }).catch((err) => {
      console.error('Audio play error:', err);
      UI.showToast('Audio playback failed on your device browser.', 'error');
    });
  };

  if (audio.readyState === 0) {
    audio.load();
  }
  startPlay();

  audio.ontimeupdate = () => {
    if (audio.duration && !isNaN(audio.duration)) {
      const pct = (audio.currentTime / audio.duration) * 100;
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (durationEl) durationEl.textContent = UI.formatDuration(audio.currentTime);
    }
  };

  audio.onended = () => {
    if (progressFill) progressFill.style.width = '0%';
    if (durationEl && audio.duration && !isNaN(audio.duration)) {
      durationEl.textContent = UI.formatDuration(audio.duration);
    }
    btn.innerHTML = `<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    if (currentAudioPlayer === audio) {
      currentAudioPlayer = null;
      currentPlayingUrl = null;
      currentPlayingBtn = null;
    }
  };
}

function seekAudio(event, mediaUrl, progressId, durationId) {
  if (currentAudioPlayer && currentPlayingUrl === mediaUrl && currentAudioPlayer.duration) {
    const progressBar = event.currentTarget;
    const rect = progressBar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    currentAudioPlayer.currentTime = pct * currentAudioPlayer.duration;
  }
}

window.toggleAudio = toggleAudio;
window.seekAudio = seekAudio;

function buildReactionsHtml() { return ''; }
function reactToMessage() {}
function updateMessageReactions() {}

window.reactToMessage = reactToMessage;

let isThemeSetupDone = false;

function setupThemeCustomizer() {
  if (isThemeSetupDone) return;
  const themeMenuBtn = document.getElementById('themeMenuBtn');
  const themeModal = document.getElementById('themeModal');
  const themeModalClose = document.getElementById('themeModalClose');
  const applyThemeBtn = document.getElementById('applyThemeBtn');

  if (!themeModal) return;
  isThemeSetupDone = true;

  // Restore saved theme on page load
  const savedTheme = localStorage.getItem('chat_theme') || 'purple';
  const savedMotion = localStorage.getItem('chat_motion') || 'floating-hearts';
  applyThemeAndMotion(savedTheme, savedMotion);

  themeMenuBtn?.addEventListener('click', () => {
    if (settingsDropdown) settingsDropdown.style.display = 'none';
    if (settingsBtn) settingsBtn.classList.remove('active');
    openThemeModal();
  });

  themeModalClose?.addEventListener('click', closeThemeModal);
  themeModal?.addEventListener('click', (e) => {
    if (e.target === themeModal) closeThemeModal();
  });

  // Color selection cards with LIVE PREVIEW
  const colorCards = themeModal.querySelectorAll('.theme-color-card');
  colorCards.forEach(card => {
    card.addEventListener('click', () => {
      colorCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const activeMotionCard = themeModal.querySelector('.theme-motion-card.active');
      applyThemeAndMotion(card.dataset.theme, activeMotionCard?.dataset.motion || 'floating-hearts');
    });
  });

  // Motion selection cards with LIVE PREVIEW
  const motionCards = themeModal.querySelectorAll('.theme-motion-card');
  motionCards.forEach(card => {
    card.addEventListener('click', () => {
      motionCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const activeColorCard = themeModal.querySelector('.theme-color-card.active');
      applyThemeAndMotion(activeColorCard?.dataset.theme || 'purple', card.dataset.motion);
    });
  });

  // Apply & Save button
  applyThemeBtn?.addEventListener('click', () => {
    const activeColorCard = themeModal.querySelector('.theme-color-card.active');
    const activeMotionCard = themeModal.querySelector('.theme-motion-card.active');

    const selectedTheme = activeColorCard?.dataset.theme || 'purple';
    const selectedMotion = activeMotionCard?.dataset.motion || 'floating-hearts';

    applyThemeAndMotion(selectedTheme, selectedMotion);
    localStorage.setItem('chat_theme', selectedTheme);
    localStorage.setItem('chat_motion', selectedMotion);

    // Broadcast theme update in real-time to partner & all tabs
    if (window.ChatSocket) {
      window.ChatSocket.emitThemeUpdate(selectedTheme, selectedMotion);
    }

    UI.showToast('Theme & Wallpaper applied! 🎨', 'success');
    closeThemeModal();
  });
}

function onThemeUpdated(theme, motion, updatedBy) {
  applyThemeAndMotion(theme, motion);
  localStorage.setItem('chat_theme', theme);
  localStorage.setItem('chat_motion', motion);
  if (updatedBy && updatedBy !== currentUser?.displayName) {
    UI.showToast(`${updatedBy} updated chat theme & wallpaper! 🎨`, 'info');
  }
}

function openThemeModal() {
  const themeModal = document.getElementById('themeModal');
  if (!themeModal) return;

  const currentTheme = localStorage.getItem('chat_theme') || 'purple';
  const currentMotion = localStorage.getItem('chat_motion') || 'floating-hearts';

  const colorCards = themeModal.querySelectorAll('.theme-color-card');
  colorCards.forEach(c => c.classList.toggle('active', c.dataset.theme === currentTheme));

  const motionCards = themeModal.querySelectorAll('.theme-motion-card');
  motionCards.forEach(c => c.classList.toggle('active', c.dataset.motion === currentMotion));

  themeModal.style.display = 'flex';
}

function closeThemeModal() {
  const themeModal = document.getElementById('themeModal');
  if (themeModal) themeModal.style.display = 'none';

  // Restore saved theme if user didn't hit Apply
  const savedTheme = localStorage.getItem('chat_theme') || 'purple';
  const savedMotion = localStorage.getItem('chat_motion') || 'floating-hearts';
  applyThemeAndMotion(savedTheme, savedMotion);
}

function applyThemeAndMotion(themeName, motionName) {
  const toRemove = [];
  document.body.classList.forEach(cls => {
    if (cls.startsWith('theme-') || cls.startsWith('motion-')) {
      toRemove.push(cls);
    }
  });
  toRemove.forEach(cls => document.body.classList.remove(cls));

  if (themeName) {
    document.body.classList.add(`theme-${themeName}`);
  }
  if (motionName) {
    document.body.classList.add(`motion-${motionName}`);
  }
}

// ─── Message Deletion & Multiple Selection Handlers (WhatsApp Style) ───

let targetDeleteMessageId = null;
let isBulkDeleteActive = false;
let isSelectionMode = false;
let selectedMessageIds = new Set();
let isDeleteListenersSetupDone = false;
let lastToggleMsgId = null;
let lastToggleTimestamp = 0;

function safeToggleMessageSelection(messageId) {
  if (!messageId) return;
  const now = Date.now();
  if (lastToggleMsgId === messageId && (now - lastToggleTimestamp < 450)) {
    return; // Block duplicate simulated click within 450ms!
  }
  lastToggleTimestamp = now;
  lastToggleMsgId = messageId;
  toggleMessageSelection(messageId);
}

function setupDeleteModalListeners() {
  if (isDeleteListenersSetupDone) return;
  isDeleteListenersSetupDone = true;

  const deleteModal = document.getElementById('deleteMessageModal');
  const deleteForEveryoneBtn = document.getElementById('deleteForEveryoneBtn');
  const deleteForMeBtn = document.getElementById('deleteForMeBtn');
  const deleteCancelBtn = document.getElementById('deleteCancelBtn');
  const deleteSelectionBtn = document.getElementById('deleteSelectionBtn');
  const cancelSelectionBtn = document.getElementById('cancelSelectionBtn');

  if (!deleteModal) return;

  deleteForEveryoneBtn?.addEventListener('click', () => {
    if (isBulkDeleteActive) {
      executeBulkDelete('everyone');
    } else {
      executeDeleteMessage('everyone');
    }
  });

  deleteForMeBtn?.addEventListener('click', () => {
    if (isBulkDeleteActive) {
      executeBulkDelete('me');
    } else {
      executeDeleteMessage('me');
    }
  });

  deleteCancelBtn?.addEventListener('click', closeDeleteModal);

  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) closeDeleteModal();
  });

  // Multiple selection action buttons
  deleteSelectionBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedMessageIds.size === 0) return;
    isBulkDeleteActive = true;
    openDeleteModal(null, false);
  });

  cancelSelectionBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    exitSelectionMode();
  });

  // Mobile Touch Tap: trigger selection immediately on finger release
  chatMessages?.addEventListener('touchend', (e) => {
    if (!isSelectionMode) return;
    const touch = e.changedTouches?.[0];
    if (!touch) return;

    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const wrapper = el?.closest('.message-wrapper');
    if (wrapper && wrapper.dataset.messageId) {
      safeToggleMessageSelection(wrapper.dataset.messageId);
    }
  }, { passive: true, capture: true });

  // Desktop Mouse Click: trigger selection on click (also handles any fallthrough clicks)
  chatMessages?.addEventListener('click', (e) => {
    if (!isSelectionMode) return;
    const wrapper = e.target.closest('.message-wrapper');
    if (wrapper && wrapper.dataset.messageId) {
      e.preventDefault();
      e.stopPropagation();
      safeToggleMessageSelection(wrapper.dataset.messageId);
    }
  }, true);

  // Global click handler for trash icon click
  document.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.msg-delete-btn');
    if (deleteBtn) {
      e.stopPropagation();
      const wrapper = deleteBtn.closest('.message-wrapper');
      const messageId = wrapper?.dataset.messageId;
      const isMe = wrapper?.dataset.sender === 'me';
      if (messageId) {
        isBulkDeleteActive = false;
        openDeleteModal(messageId, isMe);
      }
    }
  });
}

// ─── Multiple Message Selection Mode (WhatsApp Style) ──────────────

function startSelectionMode(initialMessageId = null) {
  isSelectionMode = true;
  selectedMessageIds.clear();
  if (initialMessageId) {
    selectedMessageIds.add(initialMessageId);
  }

  const chatCard = document.getElementById('chatCard');
  if (chatCard) chatCard.classList.add('in-selection-mode');

  const selHeader = document.getElementById('selectionHeader');
  if (selHeader) selHeader.style.display = 'flex';

  updateSelectionUI();
  UI.showToast('Selection mode: tap messages to select 🔘', 'info');
}

function toggleMessageSelection(messageId) {
  if (!messageId) return;

  if (selectedMessageIds.has(messageId)) {
    selectedMessageIds.delete(messageId);
  } else {
    selectedMessageIds.add(messageId);
  }

  updateSelectionUI();
}

function updateSelectionUI() {
  const countText = document.getElementById('selectionCountText');
  const deleteBtn = document.getElementById('deleteSelectionBtn');
  const count = selectedMessageIds.size;

  if (countText) {
    countText.textContent = count > 0 ? `${count} selected` : 'Select messages';
  }

  if (deleteBtn) {
    deleteBtn.style.opacity = count > 0 ? '1' : '0.4';
    deleteBtn.style.pointerEvents = count > 0 ? 'auto' : 'none';
  }

  // Highlight selected messages in the DOM
  document.querySelectorAll('.message-wrapper').forEach((el) => {
    const id = el.dataset.messageId;
    el.classList.toggle('selected', selectedMessageIds.has(id));
  });
}

function exitSelectionMode() {
  isSelectionMode = false;
  selectedMessageIds.clear();
  isBulkDeleteActive = false;

  const chatCard = document.getElementById('chatCard');
  if (chatCard) chatCard.classList.remove('in-selection-mode');

  const selHeader = document.getElementById('selectionHeader');
  if (selHeader) selHeader.style.display = 'none';

  document.querySelectorAll('.message-wrapper.selected').forEach((el) => {
    el.classList.remove('selected');
  });
}

async function executeBulkDelete(type) {
  const ids = Array.from(selectedMessageIds);
  exitSelectionMode();
  closeDeleteModal();

  if (ids.length === 0) return;

  try {
    const res = await fetch('/api/messages/bulk-delete', {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messageIds: ids, type }),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      if (type === 'me') {
        for (const id of ids) {
          const wrapper = document.querySelector(`.message-wrapper[data-message-id="${id}"]`);
          if (wrapper) wrapper.remove();
        }
        UI.showToast(`${ids.length} message(s) deleted for you 🗑️`, 'info');
      } else if (type === 'everyone') {
        for (const id of ids) {
          onMessageDeleted(id, 'everyone');
        }
        if (window.ChatSocket) {
          for (const id of ids) {
            window.ChatSocket.emitMessageDeleted({ messageId: id, type: 'everyone' });
          }
        }
        UI.showToast(`${ids.length} message(s) deleted for everyone 🗑️`, 'success');
      }
    } else {
      UI.showToast(data.error || 'Failed to delete selected messages.', 'error');
    }
  } catch (err) {
    console.error('Bulk delete error:', err);
    UI.showToast('Failed to delete messages. Check connection.', 'error');
  }
}

// ─── Reply & Context Menu System (WhatsApp Style) ───────────────────

let currentReplyTarget = null;
let contextMenuTargetWrapper = null;

function setReplyTarget(messageId, senderName, textSnippet) {
  if (!messageId) return;

  currentReplyTarget = { id: messageId, senderName, textSnippet };

  const replyPreviewBar = document.getElementById('replyPreviewBar');
  const replyPreviewTitle = document.getElementById('replyPreviewTitle');
  const replyPreviewText = document.getElementById('replyPreviewText');

  if (replyPreviewTitle) replyPreviewTitle.textContent = `Replying to ${senderName || 'Partner'}`;
  if (replyPreviewText) replyPreviewText.textContent = textSnippet || 'Message';

  if (replyPreviewBar) replyPreviewBar.style.display = 'flex';
  if (messageInput) messageInput.focus();
}

function cancelReplyPreview() {
  currentReplyTarget = null;
  const replyPreviewBar = document.getElementById('replyPreviewBar');
  if (replyPreviewBar) replyPreviewBar.style.display = 'none';
}

function setupReplyListeners() {
  const cancelReplyBtn = document.getElementById('cancelReplyBtn');
  cancelReplyBtn?.addEventListener('click', cancelReplyPreview);

  // Desktop Right-Click Context Menu
  const msgContextMenu = document.getElementById('msgContextMenu');
  const ctxReplyBtn = document.getElementById('ctxReplyBtn');
  const ctxCopyBtn = document.getElementById('ctxCopyBtn');
  const ctxDeleteBtn = document.getElementById('ctxDeleteBtn');

  document.addEventListener('click', () => {
    if (msgContextMenu) msgContextMenu.style.display = 'none';
  });

  function showContextMenu(wrapper, clientX, clientY) {
    if (!wrapper || !msgContextMenu) return;
    contextMenuTargetWrapper = wrapper;

    let left = clientX;
    let top = clientY;
    if (left + 180 > window.innerWidth) left = window.innerWidth - 185;
    if (top + 150 > window.innerHeight) top = window.innerHeight - 155;
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    msgContextMenu.style.left = `${left}px`;
    msgContextMenu.style.top = `${top}px`;
    msgContextMenu.style.display = 'flex';
  }

  // Desktop Right-Click Context Menu
  chatMessages?.addEventListener('contextmenu', (e) => {
    const wrapper = e.target.closest('.message-wrapper');
    if (!wrapper) return;

    e.preventDefault();
    showContextMenu(wrapper, e.clientX, e.clientY);
  });

  // Prevent Android/iOS native text selection and Google Search Drawer on message long-press
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) {
      const node = sel.anchorNode;
      if (node && chatMessages && chatMessages.contains(node)) {
        sel.removeAllRanges();
      }
    }
  });

  // Mobile Long-Press (Press & Hold for 450ms opens Context Menu ONLY)
  let longPressTimer = null;
  let touchStartX = 0;
  let touchStartY = 0;

  chatMessages?.addEventListener('touchstart', (e) => {
    if (isSelectionMode) return;
    const wrapper = e.target.closest('.message-wrapper');
    if (!wrapper) return;

    if (window.getSelection) window.getSelection().removeAllRanges();

    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;

    longPressTimer = setTimeout(() => {
      if (window.getSelection) window.getSelection().removeAllRanges();
      if (navigator.vibrate) navigator.vibrate(40);
      showContextMenu(wrapper, touchStartX, touchStartY);
    }, 450);
  }, { passive: true });

  chatMessages?.addEventListener('touchmove', (e) => {
    if (!longPressTimer) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - touchStartX) > 10 || Math.abs(touch.clientY - touchStartY) > 10) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, { passive: true });

  chatMessages?.addEventListener('touchend', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  chatMessages?.addEventListener('touchcancel', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  ctxReplyBtn?.addEventListener('click', () => {
    if (!contextMenuTargetWrapper) return;
    const messageId = contextMenuTargetWrapper.dataset.messageId;
    const isMe = contextMenuTargetWrapper.dataset.sender === 'me';
    const senderName = isMe ? 'You' : (partner?.displayName || partner?.username || 'Partner');
    const bubble = contextMenuTargetWrapper.querySelector('.message-bubble');
    const textSnippet = bubble ? bubble.textContent.trim() : 'Message';

    setReplyTarget(messageId, senderName, textSnippet);
    if (msgContextMenu) msgContextMenu.style.display = 'none';
  });

  ctxCopyBtn?.addEventListener('click', () => {
    if (!contextMenuTargetWrapper) return;
    const bubble = contextMenuTargetWrapper.querySelector('.message-bubble');
    if (bubble) {
      navigator.clipboard.writeText(bubble.textContent.trim());
      UI.showToast('Message copied to clipboard 📋', 'success');
    }
    if (msgContextMenu) msgContextMenu.style.display = 'none';
  });

  const ctxSelectBtn = document.getElementById('ctxSelectBtn');
  ctxSelectBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (msgContextMenu) msgContextMenu.style.display = 'none';
    if (!contextMenuTargetWrapper) return;
    const messageId = contextMenuTargetWrapper.dataset.messageId;
    startSelectionMode(messageId);
  });

  ctxDeleteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!contextMenuTargetWrapper) return;
    const messageId = contextMenuTargetWrapper.dataset.messageId;
    const isMe = contextMenuTargetWrapper.dataset.sender === 'me';
    if (msgContextMenu) msgContextMenu.style.display = 'none';
    openDeleteModal(messageId, isMe);
  });

  // Touch Drag-Right (Swipe-to-Reply)
  let swipeStartX = 0;
  let swipeStartY = 0;
  let activeSwipeWrapper = null;
  let currentDeltaX = 0;

  chatMessages?.addEventListener('touchstart', (e) => {
    if (isSelectionMode) return;
    const wrapper = e.target.closest('.message-wrapper');
    if (!wrapper) return;

    activeSwipeWrapper = wrapper;
    const touch = e.touches[0];
    swipeStartX = touch.clientX;
    swipeStartY = touch.clientY;
    currentDeltaX = 0;
  }, { passive: true });

  chatMessages?.addEventListener('touchmove', (e) => {
    if (!activeSwipeWrapper) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - swipeStartX;
    const deltaY = touch.clientY - swipeStartY;

    if (deltaX > 0 && deltaX < 85 && Math.abs(deltaY) < 30) {
      currentDeltaX = deltaX;
      activeSwipeWrapper.style.transform = `translateX(${deltaX}px)`;
      activeSwipeWrapper.classList.add('swiping');
    }
  }, { passive: true });

  chatMessages?.addEventListener('touchend', () => {
    if (!activeSwipeWrapper) return;

    if (currentDeltaX > 40) {
      const messageId = activeSwipeWrapper.dataset.messageId;
      const isMe = activeSwipeWrapper.dataset.sender === 'me';
      const senderName = isMe ? 'You' : (partner?.displayName || partner?.username || 'Partner');
      const bubble = activeSwipeWrapper.querySelector('.message-bubble');
      const textSnippet = bubble ? bubble.textContent.trim() : 'Message';

      if (navigator.vibrate) navigator.vibrate(30);
      setReplyTarget(messageId, senderName, textSnippet);
    }

    activeSwipeWrapper.style.transform = '';
    activeSwipeWrapper.classList.remove('swiping');
    activeSwipeWrapper = null;
    currentDeltaX = 0;
  });
}

function openDeleteModal(messageId, isMe) {
  targetDeleteMessageId = messageId;
  const deleteModal = document.getElementById('deleteMessageModal');
  const deleteForEveryoneBtn = document.getElementById('deleteForEveryoneBtn');
  const deleteForMeBtn = document.getElementById('deleteForMeBtn');
  if (!deleteModal) return;

  if (deleteForEveryoneBtn) deleteForEveryoneBtn.style.display = 'flex';
  if (deleteForMeBtn) deleteForMeBtn.style.display = 'flex';

  deleteModal.classList.add('active');
  deleteModal.style.setProperty('display', 'flex', 'important');
}

function closeDeleteModal() {
  targetDeleteMessageId = null;
  const deleteModal = document.getElementById('deleteMessageModal');
  if (deleteModal) {
    deleteModal.classList.remove('active');
    deleteModal.style.display = 'none';
  }
}

async function executeDeleteMessage(type) {
  if (!targetDeleteMessageId) return;
  const messageId = targetDeleteMessageId;
  closeDeleteModal();

  try {
    const res = await fetch(`/api/messages/${messageId}?type=${type}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: getAuthHeaders(),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      if (type === 'me') {
        const wrapper = document.querySelector(`.message-wrapper[data-message-id="${messageId}"]`);
        if (wrapper) wrapper.remove();
        UI.showToast('Message deleted for you 🗑️', 'info');
      } else if (type === 'everyone') {
        onMessageDeleted(messageId, 'everyone');
        if (window.ChatSocket) {
          window.ChatSocket.emitMessageDeleted(data);
        }
        UI.showToast('Message deleted for everyone 🗑️', 'success');
      }
    } else {
      UI.showToast(data.error || 'Failed to delete message.', 'error');
    }
  } catch (err) {
    console.error('Delete error:', err);
    UI.showToast('Failed to delete message.', 'error');
  }
}

function onMessageDeleted(messageId, type) {
  if (type === 'everyone') {
    const wrapper = document.querySelector(`.message-wrapper[data-message-id="${messageId}"]`);
    if (wrapper) {
      wrapper.innerHTML = `
        <div class="message-bubble deleted-message-text">🚫 This message was deleted</div>
        <div class="message-meta">
          <span class="message-time">Just now</span>
        </div>
      `;
    }
  }
}

window.openDeleteModal = openDeleteModal;

// ─── In-Chat Search ───────────────────────────────────────────────

function setupInChatSearch() {
  const searchToggleBtn = document.getElementById('searchToggleBtn');
  const chatSearchBar = document.getElementById('chatSearchBar');
  const chatSearchInput = document.getElementById('chatSearchInput');
  const closeSearchBtn = document.getElementById('closeSearchBtn');
  const searchResultCount = document.getElementById('searchResultCount');

  if (!searchToggleBtn || !chatSearchBar) return;

  searchToggleBtn.addEventListener('click', () => {
    const isVisible = chatSearchBar.style.display === 'flex';
    if (isVisible) {
      closeSearch();
    } else {
      chatSearchBar.style.display = 'flex';
      chatSearchInput?.focus();
    }
  });

  closeSearchBtn?.addEventListener('click', closeSearch);

  chatSearchInput?.addEventListener('input', () => {
    const query = chatSearchInput.value.trim().toLowerCase();
    const wrappers = chatMessages.querySelectorAll('.message-wrapper');

    if (!query) {
      wrappers.forEach(w => {
        w.style.display = 'flex';
        w.classList.remove('search-highlight');
      });
      if (searchResultCount) searchResultCount.textContent = '';
      return;
    }

    let matchCount = 0;
    let firstMatchWrapper = null;

    wrappers.forEach(w => {
      const bubble = w.querySelector('.message-bubble');
      const text = bubble ? bubble.textContent.toLowerCase() : '';
      if (text.includes(query)) {
        w.style.display = 'flex';
        w.classList.add('search-highlight');
        matchCount++;
        if (!firstMatchWrapper) firstMatchWrapper = w;
      } else {
        w.style.display = 'none';
        w.classList.remove('search-highlight');
      }
    });

    if (searchResultCount) {
      searchResultCount.textContent = matchCount > 0 ? `${matchCount} match${matchCount > 1 ? 'es' : ''}` : 'No matches';
    }

    if (firstMatchWrapper) {
      firstMatchWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  function closeSearch() {
    chatSearchBar.style.display = 'none';
    if (chatSearchInput) chatSearchInput.value = '';
    if (searchResultCount) searchResultCount.textContent = '';
    const wrappers = chatMessages.querySelectorAll('.message-wrapper');
    wrappers.forEach(w => {
      w.style.display = 'flex';
      w.classList.remove('search-highlight');
    });
  }
}

// ─── Mobile Hardware / Gesture Back Button Optimization ────────────

let lastBackPressTimestamp = 0;

function handleBackButton() {
  // 1. Multiple Message Selection Mode
  if (isSelectionMode) {
    exitSelectionMode();
    return true;
  }

  // 2. Delete Confirmation Modal
  const deleteModal = document.getElementById('deleteMessageModal');
  if (deleteModal && (deleteModal.classList.contains('active') || deleteModal.style.display === 'flex')) {
    closeDeleteModal();
    return true;
  }

  // 3. Fullscreen Image Modal
  const imageModal = document.getElementById('imageModal');
  if (imageModal && (imageModal.classList.contains('open') || imageModal.style.display === 'flex')) {
    if (window.closeImageModal) window.closeImageModal();
    return true;
  }

  // 4. Profile Modal
  const profileModal = document.getElementById('profileModal');
  if (profileModal && (profileModal.classList.contains('active') || profileModal.style.display === 'flex')) {
    closeProfileModal();
    return true;
  }

  // 5. Theme Customizer Modal
  const themeModal = document.getElementById('themeModal');
  if (themeModal && (themeModal.classList.contains('active') || themeModal.style.display === 'flex')) {
    closeThemeModal();
    return true;
  }

  // 6. Emoji Picker
  const emojiPicker = document.getElementById('emojiPicker');
  if (emojiPicker && (emojiPicker.classList.contains('open') || emojiPicker.style.display === 'block')) {
    if (window.EmojiPicker && window.EmojiPicker.close) {
      window.EmojiPicker.close();
    } else {
      emojiPicker.classList.remove('open');
    }
    return true;
  }

  // 7. Context Menu (Long-press menu)
  const msgContextMenu = document.getElementById('msgContextMenu');
  if (msgContextMenu && msgContextMenu.style.display === 'flex') {
    msgContextMenu.style.display = 'none';
    return true;
  }

  // 8. Settings Dropdown (3-dots menu)
  const settingsDropdown = document.getElementById('settingsDropdown');
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsDropdown && settingsDropdown.style.display === 'block') {
    settingsDropdown.style.display = 'none';
    if (settingsBtn) settingsBtn.classList.remove('active');
    document.body.classList.remove('menu-open');
    return true;
  }

  // 9. In-Chat Search Bar
  const chatSearchBar = document.getElementById('chatSearchBar');
  if (chatSearchBar && chatSearchBar.style.display === 'flex') {
    chatSearchBar.style.display = 'none';
    const chatSearchInput = document.getElementById('chatSearchInput');
    if (chatSearchInput) chatSearchInput.value = '';
    const wrappers = document.querySelectorAll('.message-wrapper');
    wrappers.forEach(w => {
      w.style.display = 'flex';
      w.classList.remove('search-highlight');
    });
    const searchResultCount = document.getElementById('searchResultCount');
    if (searchResultCount) searchResultCount.textContent = '';
    return true;
  }

  // 10. Reply Preview Bar
  const replyPreviewBar = document.getElementById('replyPreviewBar');
  if (replyPreviewBar && replyPreviewBar.style.display === 'flex') {
    cancelReplyPreview();
    return true;
  }

  // 11. None of the above were active -> WhatsApp-style double-back to exit
  const now = Date.now();
  if (now - lastBackPressTimestamp < 2000) {
    return false; // Exit app / allow history navigation
  } else {
    lastBackPressTimestamp = now;
    UI.showToast('Press back again to exit', 'info', 2000);
    return true;
  }
}

function setupMobileBackButtonHandling() {
  // Push an initial sentinel state into history to trap the back button
  history.pushState({ appRoot: true }, '');

  window.addEventListener('popstate', () => {
    const handled = handleBackButton();
    if (handled) {
      // Re-push sentinel state so user stays in the app
      history.pushState({ appRoot: true }, '');
    } else {
      // User pressed back twice within 2 seconds: let them exit naturally
      history.back();
    }
  });
}

// ─── Expose to window ─────────────────────────────────────────────

window.selectConversation = selectConversation;

window.Chat = {
  onReceiveMessage,
  updateMessageStatus,
  updatePartnerInfo,
  setPartnerOnline,
  showTyping,
  hideTyping,
  onReconnect,
  selectConversation,
  updateMessageReactions,
  onMessageDeleted,
  onThemeUpdated,
};

// ─── Start ────────────────────────────────────────────────────────
init();
