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

// ─── DOM References for Media Picker & In-App Private Camera ────────
const mediaPickerModal = document.getElementById('mediaPickerModal');
const openCameraBtn = document.getElementById('openCameraBtn');
const openGalleryBtn = document.getElementById('openGalleryBtn');
const mediaPickerCloseBtn = document.getElementById('mediaPickerCloseBtn');

const cameraModal = document.getElementById('cameraModal');
const cameraVideo = document.getElementById('cameraVideo');
const cameraCanvas = document.getElementById('cameraCanvas');
const cameraCloseBtn = document.getElementById('cameraCloseBtn');
const cameraFlipBtn = document.getElementById('cameraFlipBtn');
const cameraShutterBtn = document.getElementById('cameraShutterBtn');
const cameraGalleryShortcutBtn = document.getElementById('cameraGalleryShortcutBtn');

// Photo / Video mode and video recorder DOM elements
const cameraRecOverlay = document.getElementById('cameraRecOverlay');
const cameraRecTimer = document.getElementById('cameraRecTimer');
const cameraPhotoModeBtn = document.getElementById('cameraPhotoModeBtn');
const cameraVideoModeBtn = document.getElementById('cameraVideoModeBtn');
const cameraRecordBtn = document.getElementById('cameraRecordBtn');
const cameraRecordInner = document.getElementById('cameraRecordInner');

let cameraStream = null;
let currentFacingMode = 'environment'; // default to back camera, fallback to front
let currentCameraMode = 'photo'; // 'photo' | 'video'
let videoMediaRecorder = null;
let videoRecordedChunks = [];
let videoRecordingTimerInterval = null;
let videoRecordingStartTime = 0;
let isVideoRecording = false;

function openMediaPicker() {
  if (isUploading) return;
  if (mediaPickerModal) {
    mediaPickerModal.style.display = 'flex';
  }
}

function closeMediaPicker() {
  if (mediaPickerModal) {
    mediaPickerModal.style.display = 'none';
  }
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    closeCamera();
    if (!window.isSecureContext) {
      UI.showToast('Camera requires HTTPS on mobile. Use HTTPS or Choose from Gallery.', 'error', 4500);
    } else {
      UI.showToast('Camera is not supported on this browser/device.', 'error', 3000);
    }
    return;
  }

  stopCamera();

  // Helper: assign stream to video and wait for first frame (fixes black screen)
  async function attachStream(stream, mirror) {
    cameraStream = stream;
    if (!cameraVideo) return;
    cameraVideo.srcObject = stream;
    if (mirror) {
      cameraVideo.classList.add('mirror');
    } else {
      cameraVideo.classList.remove('mirror');
    }
    // Wait for metadata so video dimensions are known before play() — prevents black screen
    await new Promise((resolve) => {
      if (cameraVideo.readyState >= 1) { resolve(); return; }
      cameraVideo.addEventListener('loadedmetadata', resolve, { once: true });
      setTimeout(resolve, 2000); // safety timeout
    });
    await cameraVideo.play().catch(() => {});
  }

  const isMirror = currentFacingMode === 'user';

  // Tier 1: Ideal HD quality — no minimums (works on all devices)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    await attachStream(stream, isMirror);
    return;
  } catch (e1) {
    console.warn('Camera Tier 1 failed:', e1.name, e1.message);
  }

  // Tier 2: Only ask for facingMode — let device pick any resolution
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: false,
    });
    await attachStream(stream, isMirror);
    return;
  } catch (e2) {
    console.warn('Camera Tier 2 failed:', e2.name, e2.message);
  }

  // Tier 3: Fully unconstrained (any camera, any resolution) — last resort
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    currentFacingMode = 'user'; // unknown facing, apply mirror as safe default
    await attachStream(stream, true);
    return;
  } catch (e3) {
    console.warn('Camera Tier 3 failed:', e3.name, e3.message);
    closeCamera();
    if (e3.name === 'NotAllowedError' || e3.name === 'PermissionDeniedError') {
      // Show guide modal — user needs to go to browser settings
      showCameraPermModal();
    } else if (e3.name === 'NotFoundError' || e3.name === 'DevicesNotFoundError') {
      UI.showToast('No camera found on this device.', 'error', 3000);
    } else {
      UI.showToast('Could not access camera. Try choosing from Gallery instead.', 'error', 3500);
    }
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => {
      try { track.stop(); } catch(e) {}
    });
    cameraStream = null;
  }
  if (cameraVideo) {
    cameraVideo.srcObject = null;
  }
}

// ─── Camera Permission Guide Modal ───────────────────────────────────
const cameraPermissionModal = document.getElementById('cameraPermissionModal');
const cameraPermTryAgainBtn = document.getElementById('cameraPermTryAgainBtn');
const cameraPermCloseBtn = document.getElementById('cameraPermCloseBtn');

function showCameraPermModal() {
  if (cameraPermissionModal) cameraPermissionModal.style.display = 'flex';
}

function hideCameraPermModal() {
  if (cameraPermissionModal) cameraPermissionModal.style.display = 'none';
}

if (cameraPermTryAgainBtn) {
  cameraPermTryAgainBtn.addEventListener('click', async () => {
    hideCameraPermModal();
    // Open camera modal first so user sees a loading state
    if (cameraModal) cameraModal.style.display = 'flex';
    await startCamera();
    // If stream failed (still no srcObject), show the guide again
    if (!cameraStream) {
      if (cameraModal) cameraModal.style.display = 'none';
      showCameraPermModal();
    }
  });
}

if (cameraPermCloseBtn) {
  cameraPermCloseBtn.addEventListener('click', () => {
    hideCameraPermModal();
  });
}

async function openCamera() {
  closeMediaPicker();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (!window.isSecureContext) {
      UI.showToast('Camera requires HTTPS on mobile. Use HTTPS or Choose from Gallery.', 'error', 4500);
    } else {
      UI.showToast('Camera is not supported on this browser/device.', 'error', 3000);
    }
    return;
  }

  // Check current permission state using Permissions API (supported on Chrome/Android)
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const permResult = await navigator.permissions.query({ name: 'camera' });

      if (permResult.state === 'denied') {
        // Browser has remembered "Block" — we cannot re-prompt, show settings guide
        showCameraPermModal();
        return;
      }

      // If 'prompt': browser will show its native dialog — open modal first,
      // then startCamera will trigger the prompt
      if (permResult.state === 'prompt') {
        // Show permission guide so user knows what to expect
        showCameraPermModal();
        return;
      }
      // state === 'granted': fall through and open camera directly
    }
  } catch (_) {
    // Permissions API not supported (e.g. Safari) — try directly
  }

  if (cameraModal) cameraModal.style.display = 'flex';
  setCameraMode('photo'); // default to photo mode on open
  await startCamera();
  if (!cameraStream) {
    if (cameraModal) cameraModal.style.display = 'none';
  }
}

function closeCamera() {
  if (isVideoRecording) {
    stopVideoRecording(true); // discard recording if closed while filming
  }
  stopCamera();
  if (cameraModal) {
    cameraModal.style.display = 'none';
  }
  setCameraMode('photo');
}

async function flipCamera() {
  if (isVideoRecording) return;
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  await startCamera();
}

function setCameraMode(mode) {
  if (isVideoRecording) {
    UI.showToast('Please stop video recording first.', 'info');
    return;
  }
  currentCameraMode = mode;
  if (mode === 'video') {
    if (cameraPhotoModeBtn) cameraPhotoModeBtn.classList.remove('active');
    if (cameraVideoModeBtn) cameraVideoModeBtn.classList.add('active');
    if (cameraShutterBtn) cameraShutterBtn.style.display = 'none';
    if (cameraRecordBtn) cameraRecordBtn.style.display = 'flex';
    // If live camera stream exists and doesn't have an audio track yet, attach one
    if (cameraStream && cameraStream.getAudioTracks().length === 0 && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((audioStream) => {
        const audioTrack = audioStream.getAudioTracks()[0];
        if (audioTrack && cameraStream) {
          cameraStream.addTrack(audioTrack);
        }
      }).catch((e) => {
        console.warn('Microphone permission not granted for camera video:', e);
      });
    }
  } else {
    if (cameraPhotoModeBtn) cameraPhotoModeBtn.classList.add('active');
    if (cameraVideoModeBtn) cameraVideoModeBtn.classList.remove('active');
    if (cameraShutterBtn) cameraShutterBtn.style.display = 'flex';
    if (cameraRecordBtn) cameraRecordBtn.style.display = 'none';
    // If switching back to photo mode, stop and remove audio tracks to release microphone
    if (cameraStream) {
      cameraStream.getAudioTracks().forEach(track => {
        try { track.stop(); } catch(e) {}
        try { cameraStream.removeTrack(track); } catch(e) {}
      });
    }
  }
}

async function startVideoRecording() {
  if (!cameraStream || isVideoRecording) return;

  // Make sure we have an audio track if possible
  if (cameraStream.getAudioTracks().length === 0 && navigator.mediaDevices?.getUserMedia) {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioTrack = audioStream.getAudioTracks()[0];
      if (audioTrack && cameraStream) {
        cameraStream.addTrack(audioTrack);
      }
    } catch (micErr) {
      console.warn('Video recording without audio (mic denied/unavailable):', micErr);
    }
  }

  // Pick best supported video MIME type
  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
  ];
  let chosenMime = '';
  for (const m of mimeTypes) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
      chosenMime = m;
      break;
    }
  }

  videoRecordedChunks = [];
  try {
    const options = chosenMime ? { mimeType: chosenMime } : {};
    videoMediaRecorder = new MediaRecorder(cameraStream, options);
  } catch (err) {
    console.error('Cannot create MediaRecorder for video:', err);
    UI.showToast('Video recording is not supported on this browser.', 'error');
    return;
  }

  videoMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      videoRecordedChunks.push(e.data);
    }
  };

  videoMediaRecorder.onstop = () => {
    finishVideoRecording(chosenMime);
  };

  try {
    videoMediaRecorder.start(250);
    isVideoRecording = true;
    videoRecordingStartTime = Date.now();

    // UI Updates
    if (cameraRecordBtn) cameraRecordBtn.classList.add('recording');
    if (cameraRecOverlay) cameraRecOverlay.style.display = 'flex';
    if (cameraRecTimer) cameraRecTimer.textContent = '0:00';
    if (cameraFlipBtn) {
      cameraFlipBtn.style.opacity = '0.3';
      cameraFlipBtn.style.pointerEvents = 'none';
    }
    if (cameraPhotoModeBtn) cameraPhotoModeBtn.style.pointerEvents = 'none';

    clearInterval(videoRecordingTimerInterval);
    videoRecordingTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - videoRecordingStartTime) / 1000);
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      if (cameraRecTimer) {
        cameraRecTimer.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
      }
      // Max 5 minutes limit
      if (elapsedSec >= 300) {
        stopVideoRecording(false);
      }
    }, 1000);
  } catch (err) {
    console.error('Failed to start video recording:', err);
    UI.showToast('Could not start recording. Please try again.', 'error');
    isVideoRecording = false;
  }
}

function stopVideoRecording(discard = false) {
  if (!isVideoRecording || !videoMediaRecorder) return;
  clearInterval(videoRecordingTimerInterval);
  videoRecordingTimerInterval = null;
  isVideoRecording = false;

  if (cameraRecordBtn) cameraRecordBtn.classList.remove('recording');
  if (cameraRecOverlay) cameraRecOverlay.style.display = 'none';
  if (cameraFlipBtn) {
    cameraFlipBtn.style.opacity = '';
    cameraFlipBtn.style.pointerEvents = '';
  }
  if (cameraPhotoModeBtn) cameraPhotoModeBtn.style.pointerEvents = '';

  if (discard) {
    videoRecordedChunks = [];
    try {
      videoMediaRecorder.onstop = null;
      if (videoMediaRecorder.state !== 'inactive') {
        videoMediaRecorder.stop();
      }
    } catch (_) {}
    return;
  }

  try {
    if (videoMediaRecorder.state !== 'inactive') {
      videoMediaRecorder.stop();
    }
  } catch (err) {
    console.warn('Error stopping videoMediaRecorder:', err);
  }
}

function finishVideoRecording(usedMimeType) {
  if (!videoRecordedChunks || videoRecordedChunks.length === 0) {
    UI.showToast('No video data captured.', 'error');
    return;
  }

  const durationSec = Math.max(1, Math.round((Date.now() - videoRecordingStartTime) / 1000));
  const cleanMime = (usedMimeType || 'video/webm').split(';')[0].trim().toLowerCase();
  const ext = cleanMime.includes('mp4') ? 'mp4' : 'webm';
  const videoBlob = new Blob(videoRecordedChunks, { type: cleanMime });
  videoRecordedChunks = [];

  const maxMB = 50;
  if (videoBlob.size > maxMB * 1024 * 1024) {
    UI.showToast(`Recorded video is too large (max ${maxMB}MB).`, 'error');
    return;
  }

  const videoFile = new File([videoBlob], `video-${Date.now()}.${ext}`, { type: cleanMime });

  // Close live camera modal & stop stream
  closeCamera();

  // Setup preview modal
  selectedMediaFile = videoFile;
  mediaType = 'video';
  mediaDuration = durationSec;

  if (videoBlobUrl) {
    URL.revokeObjectURL(videoBlobUrl);
    videoBlobUrl = null;
  }

  videoBlobUrl = URL.createObjectURL(videoBlob);
  if (photoPreviewImg) {
    photoPreviewImg.src = '';
    photoPreviewImg.style.display = 'none';
  }
  if (videoPreviewPlayer) {
    videoPreviewPlayer.src = videoBlobUrl;
    videoPreviewPlayer.style.display = 'block';
  }

  photoSend.textContent = 'Send Video 🎥';
  photoPreviewContainer.classList.add('active');
  const inputRowEl = document.querySelector('.input-row');
  if (inputRowEl) inputRowEl.style.display = 'none';
}

async function takePhoto() {
  if (!cameraVideo || !cameraStream) return;

  try {
    const videoTrack = cameraStream.getVideoTracks()[0];
    let capturedBlob = null;

    // 1. Try Native Hardware Still Photo via ImageCapture (Maximum Hardware HD / Megapixels!)
    if (window.ImageCapture && videoTrack) {
      try {
        const imageCapture = new window.ImageCapture(videoTrack);
        const capabilities = await imageCapture.getPhotoCapabilities?.().catch(() => null);
        const photoSettings = {};
        if (capabilities) {
          if (capabilities.imageWidth?.max) photoSettings.imageWidth = capabilities.imageWidth.max;
          if (capabilities.imageHeight?.max) photoSettings.imageHeight = capabilities.imageHeight.max;
        }
        const rawBlob = await imageCapture.takePhoto(photoSettings);

        // If selfie front camera, mirror image naturally preserving high resolution
        if (currentFacingMode === 'user' && cameraCanvas) {
          const imgBitmap = await createImageBitmap(rawBlob);
          cameraCanvas.width = imgBitmap.width;
          cameraCanvas.height = imgBitmap.height;
          const ctx = cameraCanvas.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.translate(imgBitmap.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(imgBitmap, 0, 0);
            capturedBlob = await new Promise(resolve => cameraCanvas.toBlob(resolve, 'image/jpeg', 0.98));
          } else {
            capturedBlob = rawBlob;
          }
        } else {
          capturedBlob = rawBlob;
        }
      } catch (icErr) {
        console.warn('ImageCapture still capture failed, falling back to high-res canvas:', icErr);
      }
    }

    // 2. High-Res Canvas Fallback (if ImageCapture is unavailable or Safari)
    if (!capturedBlob) {
      if (!cameraCanvas) return;
      const w = cameraVideo.videoWidth || 1920;
      const h = cameraVideo.videoHeight || 1080;

      cameraCanvas.width = w;
      cameraCanvas.height = h;

      const ctx = cameraCanvas.getContext('2d');
      if (!ctx) return;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Mirror selfie image naturally like a front camera
      if (currentFacingMode === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(cameraVideo, 0, 0, w, h);

      capturedBlob = await new Promise(resolve => cameraCanvas.toBlob(resolve, 'image/jpeg', 0.98));
    }

    if (!capturedBlob) {
      UI.showToast('Failed to capture photo.', 'error');
      return;
    }

    // Create File in RAM only — never written to disk or device gallery!
    const capturedFile = new File([capturedBlob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });

    // Instantly close live camera stream
    closeCamera();

    // Prepare in-memory preview
    selectedMediaFile = capturedFile;
    mediaType = 'image';
    mediaDuration = null;

    if (videoBlobUrl) {
      URL.revokeObjectURL(videoBlobUrl);
      videoBlobUrl = null;
    }

    if (videoPreviewPlayer) {
      videoPreviewPlayer.pause();
      videoPreviewPlayer.src = '';
      videoPreviewPlayer.style.display = 'none';
    }

    if (photoPreviewImg) {
      photoPreviewImg.src = URL.createObjectURL(capturedBlob);
      photoPreviewImg.style.display = 'block';
    }

    photoSend.textContent = 'Send Photo (HD) ❤️';
    photoPreviewContainer.classList.add('active');
    const inputRowEl = document.querySelector('.input-row');
    if (inputRowEl) inputRowEl.style.display = 'none';
  } catch (err) {
    console.error('takePhoto error:', err);
    UI.showToast('Could not capture photo. Please try again.', 'error');
  }
}

// ─── Attach Events for Media Picker & Camera ────────────────────────
if (photoBtn) photoBtn.addEventListener('click', openMediaPicker);
if (mediaPickerCloseBtn) mediaPickerCloseBtn.addEventListener('click', closeMediaPicker);
if (openGalleryBtn) {
  openGalleryBtn.addEventListener('click', () => {
    closeMediaPicker();
    if (photoInput) photoInput.click();
  });
}
if (openCameraBtn) openCameraBtn.addEventListener('click', openCamera);
if (cameraCloseBtn) cameraCloseBtn.addEventListener('click', closeCamera);
if (cameraFlipBtn) cameraFlipBtn.addEventListener('click', flipCamera);
if (cameraShutterBtn) cameraShutterBtn.addEventListener('click', takePhoto);
if (cameraPhotoModeBtn) cameraPhotoModeBtn.addEventListener('click', () => setCameraMode('photo'));
if (cameraVideoModeBtn) cameraVideoModeBtn.addEventListener('click', () => setCameraMode('video'));
if (cameraRecordBtn) {
  cameraRecordBtn.addEventListener('click', () => {
    if (!isVideoRecording) {
      startVideoRecording();
    } else {
      stopVideoRecording(false);
    }
  });
}
if (cameraGalleryShortcutBtn) {
  cameraGalleryShortcutBtn.addEventListener('click', () => {
    closeCamera();
    if (photoInput) photoInput.click();
  });
}

// Expose modal helpers for back button handling
window.closeMediaPicker = closeMediaPicker;
window.closeCamera = closeCamera;
window.cancelPhotoSelection = cancelPhotoSelection;

if (mediaPickerModal) {
  mediaPickerModal.addEventListener('click', (e) => {
    if (e.target === mediaPickerModal) {
      closeMediaPicker();
    }
  });
}

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

    // Play WhatsApp send pop sound
    if (typeof window.playMessageSentSound === 'function') {
      window.playMessageSentSound();
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
// VOICE RECORDING & PERMISSION RE-PROMPT
// ═══════════════════════════════════════════════════════════════════

const micPermissionModal = document.getElementById('micPermissionModal');
const micPermTryAgainBtn = document.getElementById('micPermTryAgainBtn');
const micPermCloseBtn = document.getElementById('micPermCloseBtn');

function openMicPermissionModal() {
  if (micPermissionModal) {
    micPermissionModal.style.display = 'flex';
  }
}

function closeMicPermissionModal() {
  if (micPermissionModal) {
    micPermissionModal.style.display = 'none';
  }
}

if (micPermCloseBtn) {
  micPermCloseBtn.addEventListener('click', closeMicPermissionModal);
}

if (micPermTryAgainBtn) {
  micPermTryAgainBtn.addEventListener('click', async () => {
    closeMicPermissionModal();
    // Re-prompt microphone permission directly on user gesture
    await startRecording();
  });
}

micBtn.addEventListener('click', startRecording);

async function startRecording() {
  if (isUploading) return;

  // Check browser support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
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
    console.warn('Microphone access issue:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError') {
      openMicPermissionModal();
    } else {
      UI.showToast('Could not start recording. Tap to try again.', 'error');
    }
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

    // Play WhatsApp send pop sound
    if (typeof window.playMessageSentSound === 'function') {
      window.playMessageSentSound();
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
