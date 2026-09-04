'use strict';

/**
 * ui.js — Shared UI utilities
 * Toast notifications, modal helpers, spinner, time formatting.
 */

// ─── Global Auth Header Helper ────────────────────────────────────
window.getAuthHeaders = function(existingHeaders = {}) {
  const token = localStorage.getItem('chatToken');
  if (token) {
    existingHeaders['Authorization'] = `Bearer ${token}`;
  }
  return existingHeaders;
};

// ─── Toast Notifications ─────────────────────────────────────────

const toastContainer = document.getElementById('toastContainer');

/**
 * Show a toast notification
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} duration - ms before auto-remove
 */
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, duration);
}

// ─── Image Modal ──────────────────────────────────────────────────

const imageModal = document.getElementById('imageModal');
const imageModalImg = document.getElementById('imageModalImg');
const imageModalClose = document.getElementById('imageModalClose');
const imageModalDownload = document.getElementById('imageModalDownload');

let currentImageUrl = null;
let currentImageFilename = null;

function openImageModal(url, filename) {
  currentImageUrl = url;
  currentImageFilename = filename || 'chat-photo.jpg';
  imageModalImg.src = url;
  imageModal.style.display = 'flex';
  imageModal.classList.add('open');
  imageModal.focus();
}

function closeImageModal() {
  imageModal.classList.remove('open');
  imageModal.style.display = 'none';
  imageModalImg.src = '';
  currentImageUrl = null;
}

window.openImageModal = openImageModal;
window.closeImageModal = closeImageModal;

imageModalClose.addEventListener('click', closeImageModal);

imageModalDownload.addEventListener('click', () => {
  if (!currentImageUrl) return;
  const a = document.createElement('a');
  a.href = currentImageUrl + '?download=true';
  a.download = currentImageFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// Close modal on overlay click
imageModal.addEventListener('click', (e) => {
  if (e.target === imageModal || e.target.classList.contains('image-modal-body')) {
    closeImageModal();
  }
});

// ─── Video Modal ──────────────────────────────────────────────────

const videoModal = document.getElementById('videoModal');
const videoModalPlayer = document.getElementById('videoModalPlayer');
const videoModalClose = document.getElementById('videoModalClose');
const videoModalDownload = document.getElementById('videoModalDownload');

let currentVideoUrl = null;
let currentVideoFilename = null;

function openVideoModal(url, filename) {
  currentVideoUrl = url;
  currentVideoFilename = filename || 'chat-video.mp4';
  if (videoModalPlayer) {
    videoModalPlayer.src = url;
    videoModalPlayer.currentTime = 0;
    videoModalPlayer.load();
    const p = videoModalPlayer.play();
    if (p !== undefined) {
      p.catch(() => {});
    }
  }
  if (videoModal) {
    videoModal.style.display = 'flex';
    videoModal.classList.add('open');
  }
}

function closeVideoModal() {
  if (videoModal) {
    videoModal.classList.remove('open');
    videoModal.style.display = 'none';
  }
  if (videoModalPlayer) {
    videoModalPlayer.pause();
    videoModalPlayer.src = '';
  }
  currentVideoUrl = null;
}

window.openVideoModal = openVideoModal;
window.closeVideoModal = closeVideoModal;

if (videoModalClose) {
  videoModalClose.addEventListener('click', closeVideoModal);
}

if (videoModalDownload) {
  videoModalDownload.addEventListener('click', () => {
    if (!currentVideoUrl) return;
    const a = document.createElement('a');
    a.href = currentVideoUrl + '?download=true';
    a.download = currentVideoFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

// Close video modal on overlay click
if (videoModal) {
  videoModal.addEventListener('click', (e) => {
    if (e.target === videoModal || e.target.classList.contains('video-modal-body')) {
      closeVideoModal();
    }
  });
}

// Close modals on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (imageModal && imageModal.classList.contains('open')) {
      closeImageModal();
    }
    if (videoModal && videoModal.classList.contains('open')) {
      closeVideoModal();
    }
  }
});

// ─── Time Formatting ──────────────────────────────────────────────

/**
 * Format a date to "10:32 PM" or "10:32" depending on locale
 */
function formatTime(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date to a readable label like "Today", "Yesterday", or "24 August 2026"
 */
function formatDateLabel(date) {
  const d = new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const diffDays = Math.round((today - msgDay) / (1000 * 60 * 60 * 24));

  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'long' });
  const year = d.getFullYear();
  const fullDate = `${day} ${month} ${year}`;

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return fullDate;
}

/**
 * Format a lastSeen date to human-readable string
 */
function formatLastSeen(date) {
  if (!date) return 'Last seen a while ago';
  const d = new Date(date);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Last seen just now';
  if (diffMins < 60) return `Last seen ${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `Last seen at ${formatTime(d)}`;
  return `Last seen ${formatDateLabel(d)} at ${formatTime(d)}`;
}

/**
 * Format audio duration seconds to "0:18" format
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Auto-resize textarea ─────────────────────────────────────────

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

// ─── Exports (module-style using window object) ───────────────────
window.UI = {
  showToast,
  openImageModal,
  closeImageModal,
  openVideoModal,
  closeVideoModal,
  formatTime,
  formatDateLabel,
  formatLastSeen,
  formatDuration,
  autoResize,
};
