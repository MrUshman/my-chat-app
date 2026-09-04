'use strict';

/**
 * media.js — Photo and voice message handling
 * Handles: photo selection + preview + upload
 *          voice recording + preview + upload
 */

// ─── DOM References ───────────────────────────────────────────────
const photoBtn = document.getElementById('photoBtn');
const photoInput = document.getElementById('photoInput');
const photoPreviewContainer = document.getElementById('photoPreviewContainer');
const photoPreviewImg = document.getElementById('photoPreviewImg');
const videoPreviewPlayer = document.getElementById('videoPreviewPlayer');
const photoCancel = document.getElementById('photoCancel');
const photoSend = document.getElementById('photoSend');

const micBtn = document.getElementById('micBtn');
const voiceRecorder = document.getElementById('voiceRecorder');
const recordingDuration = document.getElementById('recordingDuration');
const recordingCancel = document.getElementById('recordingCancel');
const recordingStop = document.getElementById('recordingStop');

const voicePreview = document.getElementById('voicePreview');
const voicePreviewDuration = document.getElementById('voicePreviewDuration');
const voicePreviewPlay = document.getElementById('voicePreviewPlay');
const voicePreviewCancel = document.getElementById('voicePreviewCancel');
const voicePreviewSend = document.getElementById('voicePreviewSend');

// ─── State ────────────────────────────────────────────────────────
let selectedMediaFile = null;
let mediaType = null; // 'image' | 'video'
let mediaDuration = null;
let videoBlobUrl = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;
let recordingSeconds = 0;
let recordedBlob = null;
let previewAudio = null;
let isUploading = false;

// ═══════════════════════════════════════════════════════════════════
// PHOTO & VIDEO HANDLING (50 MB MAX)
// ═══════════════════════════════════════════════════════════════════

photoBtn.addEventListener('click', () => {
  if (isUploading) return;
  photoInput.click();
});

photoInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/') ||
    ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp', 'video/ogg'].includes(file.type);

  if (!isImage && !isVideo) {
    UI.showToast('Please select a valid photo or video file.', 'error');
    photoInput.value = '';
    return;
  }

  // Validate size (50MB max)
  const maxMB = 50;
  if (file.size > maxMB * 1024 * 1024) {
    UI.showToast(`File too large. Maximum allowed size is ${maxMB}MB.`, 'error');
    photoInput.value = '';
    return;
  }

  selectedMediaFile = file;
  mediaType = isVideo ? 'video' : 'image';
  mediaDuration = null;

  if (videoBlobUrl) {
    URL.revokeObjectURL(videoBlobUrl);
    videoBlobUrl = null;
  }

  if (isVideo) {
    videoBlobUrl = URL.createObjectURL(file);
    if (photoPreviewImg) photoPreviewImg.style.display = 'none';
    if (videoPreviewPlayer) {
      videoPreviewPlayer.src = videoBlobUrl;
      videoPreviewPlayer.style.display = 'block';
      videoPreviewPlayer.onloadedmetadata = () => {
        mediaDuration = videoPreviewPlayer.duration;
      };
    }
    photoSend.textContent = 'Send Video 🎥';
  } else {
    if (videoPreviewPlayer) {
      videoPreviewPlayer.pause();
      videoPreviewPlayer.src = '';
      videoPreviewPlayer.style.display = 'none';
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (photoPreviewImg) {
        photoPreviewImg.src = ev.target.result;
        photoPreviewImg.style.display = 'block';
      }
    };
    reader.readAsDataURL(file);
    photoSend.textContent = 'Send Photo ❤️';
  }

  // Show preview and hide input row
  photoPreviewContainer.classList.add('active');
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'none';
});

photoCancel.addEventListener('click', cancelPhotoSelection);

function cancelPhotoSelection() {
  selectedMediaFile = null;
  mediaType = null;
  mediaDuration = null;
  photoInput.value = '';
  if (photoPreviewImg) {
    photoPreviewImg.src = '';
    photoPreviewImg.style.display = 'none';
  }
  if (videoPreviewPlayer) {
    videoPreviewPlayer.pause();
    videoPreviewPlayer.src = '';
    videoPreviewPlayer.style.display = 'none';
  }
  if (videoBlobUrl) {
    URL.revokeObjectURL(videoBlobUrl);
    videoBlobUrl = null;
  }
  photoPreviewContainer.classList.remove('active');
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'flex';
}

photoSend.addEventListener('click', uploadAndSendMedia);

async function uploadAndSendMedia() {
  if (!selectedMediaFile || isUploading) return;

  const currentType = mediaType;
  isUploading = true;
  photoSend.disabled = true;
  photoSend.textContent = currentType === 'video' ? 'Uploading Video...' : 'Uploading Photo...';

  try {
    const formData = new FormData();
    formData.append('file', selectedMediaFile);
    if (mediaDuration) {
      formData.append('duration', String(mediaDuration));
    }

    // Attach replyTo ID if currently replying
    if (window.currentReplyingMessageId) {
      formData.append('replyTo', window.currentReplyingMessageId);
    }

    const headers = typeof window.getAuthHeaders === 'function' ? window.getAuthHeaders() : {};
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
    });

    const data = await res.json();

    if (!res.ok) {
      UI.showToast(data.error || 'Upload failed.', 'error');
      return;
    }

    // Broadcast via socket
    if (window.ChatSocket) {
      window.ChatSocket.sendMediaMessage(data.message._id);
    }

    // Reset reply bar if open
    if (typeof window.cancelQuotedReply === 'function') {
      window.cancelQuotedReply();
    }

    cancelPhotoSelection();
    UI.showToast(currentType === 'video' ? '🎥 Video sent!' : '📷 Photo sent!', 'success');
  } catch (err) {
    UI.showToast('Upload failed. Check your connection.', 'error');
    console.error('Media upload error:', err);
  } finally {
    isUploading = false;
    photoSend.disabled = false;
    photoSend.textContent = 'Send Media ❤️';
  }
}

// ═══════════════════════════════════════════════════════════════════
// VOICE RECORDING
// ═══════════════════════════════════════════════════════════════════

micBtn.addEventListener('click', startRecording);

async function startRecording() {
  if (isUploading) return;

  // Check browser support
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    UI.showToast('Voice recording is not supported in this browser.', 'error');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    audioChunks = [];
    recordingSeconds = 0;

    // Determine best supported MIME type
    const mimeType = getSupportedAudioMime();
    const options = mimeType ? { mimeType } : {};

    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      // Stop all tracks to release mic
      stream.getTracks().forEach(t => t.stop());

      recordedBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
      showVoicePreview();
    };

    mediaRecorder.start(100); // collect data every 100ms

    // Show recording UI and hide input row
    voiceRecorder.classList.add('active');
    micBtn.classList.add('active');
    const inputRowEl = document.querySelector('.input-row');
    if (inputRowEl) inputRowEl.style.display = 'none';

    // Update duration display
    recordingInterval = setInterval(() => {
      recordingSeconds++;
      recordingDuration.textContent = UI.formatDuration(recordingSeconds);
    }, 1000);

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      UI.showToast('Microphone permission denied. Please allow microphone access.', 'error');
    } else {
      UI.showToast('Could not start recording.', 'error');
    }
    console.error('Recording error:', err);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      if (typeof mediaRecorder.requestData === 'function') {
        mediaRecorder.requestData();
      }
    } catch (e) {}
    mediaRecorder.stop();
    clearInterval(recordingInterval);
    voiceRecorder.classList.remove('active');
    micBtn.classList.remove('active');
  }
}

recordingStop.addEventListener('click', stopRecording);

recordingCancel.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Prevent onstop from showing preview
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
    mediaRecorder.stream?.getTracks().forEach(t => t.stop());
  }
  clearInterval(recordingInterval);
  voiceRecorder.classList.remove('active');
  micBtn.classList.remove('active');
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'flex';
  audioChunks = [];
  recordedBlob = null;
});

function showVoicePreview() {
  voicePreviewDuration.textContent = UI.formatDuration(recordingSeconds);
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'none';

  // Create preview audio element
  if (previewAudio) {
    previewAudio.pause();
    URL.revokeObjectURL(previewAudio.src);
  }
  previewAudio = new Audio(URL.createObjectURL(recordedBlob));
  previewAudio.volume = 1.0;
  previewAudio.muted = false;

  voiceRecorder.classList.remove('active');
  voicePreview.classList.add('active');
}

voicePreviewPlay.addEventListener('click', () => {
  if (!previewAudio) return;
  if (previewAudio.paused) {
    previewAudio.volume = 1.0;
    previewAudio.muted = false;
    previewAudio.play().then(() => {
      voicePreviewPlay.textContent = '⏸ Pause';
    }).catch(err => {
      console.error('Preview audio play error:', err);
    });
    previewAudio.onended = () => {
      voicePreviewPlay.textContent = '▶ Play';
    };
  } else {
    previewAudio.pause();
    voicePreviewPlay.textContent = '▶ Play';
  }
});

voicePreviewCancel.addEventListener('click', cancelVoicePreview);

function cancelVoicePreview() {
  if (previewAudio) {
    previewAudio.pause();
    URL.revokeObjectURL(previewAudio.src);
    previewAudio = null;
  }
  recordedBlob = null;
  audioChunks = [];
  voicePreview.classList.remove('active');
  voicePreviewPlay.textContent = '▶ Play';
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'flex';
}

voicePreviewSend.addEventListener('click', uploadAndSendVoice);

async function uploadAndSendVoice() {
  if (!recordedBlob || isUploading) return;

  isUploading = true;
  voicePreviewSend.disabled = true;
  voicePreviewSend.textContent = 'Sending...';

  try {
    const cleanMime = (recordedBlob.type || 'audio/webm').split(';')[0].trim();
    const ext = cleanMime.includes('ogg') ? 'ogg'
      : cleanMime.includes('mp4') ? 'mp4'
      : 'webm';

    const file = new File([recordedBlob], `voice.${ext}`, { type: cleanMime });
    const formData = new FormData();
    formData.append('file', file);
    formData.append('duration', String(recordingSeconds));

    const headers = typeof window.getAuthHeaders === 'function' ? window.getAuthHeaders() : {};
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
    });

    const data = await res.json();

    if (!res.ok) {
      UI.showToast(data.error || 'Upload failed.', 'error');
      return;
    }

    // Broadcast via socket
    if (window.ChatSocket) {
      window.ChatSocket.sendMediaMessage(data.message._id);
    }

    cancelVoicePreview();
    UI.showToast('Voice message sent!', 'success');
  } catch (err) {
    UI.showToast('Upload failed. Check your connection.', 'error');
    console.error('Voice upload error:', err);
  } finally {
    isUploading = false;
    voicePreviewSend.disabled = false;
    voicePreviewSend.textContent = 'Send 🎙️';
  }
}

// ─── Helper: get best supported audio MIME ────────────────────────

function getSupportedAudioMime() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

window.Media = { cancelPhotoSelection, cancelVoicePreview };
