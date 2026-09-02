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
let selectedPhotoFile = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;
let recordingSeconds = 0;
let recordedBlob = null;
let previewAudio = null;
let isUploading = false;

// ═══════════════════════════════════════════════════════════════════
// PHOTO HANDLING
// ═══════════════════════════════════════════════════════════════════

photoBtn.addEventListener('click', () => {
  if (isUploading) return;
  photoInput.click();
});

photoInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Validate MIME type
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    UI.showToast('Only JPG, PNG, and WEBP images are allowed.', 'error');
    photoInput.value = '';
    return;
  }

  // Validate size (10MB max)
  const maxMB = 10;
  if (file.size > maxMB * 1024 * 1024) {
    UI.showToast(`Image too large. Max ${maxMB}MB.`, 'error');
    photoInput.value = '';
    return;
  }

  selectedPhotoFile = file;

  // Show preview and hide input row
  const reader = new FileReader();
  reader.onload = (ev) => {
    photoPreviewImg.src = ev.target.result;
    photoPreviewContainer.classList.add('active');
    const inputRowEl = document.querySelector('.input-row');
    if (inputRowEl) inputRowEl.style.display = 'none';
  };
  reader.readAsDataURL(file);
});

photoCancel.addEventListener('click', cancelPhotoSelection);

function cancelPhotoSelection() {
  selectedPhotoFile = null;
  photoInput.value = '';
  photoPreviewImg.src = '';
  photoPreviewContainer.classList.remove('active');
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'flex';
}

photoSend.addEventListener('click', uploadAndSendPhoto);

async function uploadAndSendPhoto() {
  if (!selectedPhotoFile || isUploading) return;

  isUploading = true;
  photoSend.disabled = true;
  photoSend.textContent = 'Sending...';

  try {
    const formData = new FormData();
    formData.append('file', selectedPhotoFile);

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

    cancelPhotoSelection();
    UI.showToast('Photo sent!', 'success');
  } catch (err) {
    UI.showToast('Upload failed. Check your connection.', 'error');
    console.error('Photo upload error:', err);
  } finally {
    isUploading = false;
    photoSend.disabled = false;
    photoSend.textContent = 'Send Photo ❤️';
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
