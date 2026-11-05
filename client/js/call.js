'use strict';

/**
 * call.js — WhatsApp-Style Real-time WebRTC Audio & Video Calling Engine
 * 100% Peer-to-Peer (0 MB Render server bandwidth consumption)
 * Uses pure Web Audio API for telephone ringtones (zero audio asset dependencies)
 */

(function () {
  // ─── Configuration ──────────────────────────────────────────────────────────
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    iceCandidatePoolSize: 2,
    bundlePolicy: 'max-bundle', // Multiplex all tracks onto single UDP transport
    rtcpMuxPolicy: 'require',
  };

  // ─── WebRTC SDP Optimization for HD Audio, Sharp Video & Error Correction ───
  function optimizeSdp(sdp, isVideo, isAnswer = false) {
    if (!sdp) return sdp;
    try {
      const lines = sdp.split(/\r?\n/);

      // 1. Audio Optimization: Opus HD Voice, Constant Bitrate (CBR), In-Band FEC, Zero DTX Gating
      const opusRtpLine = lines.find((l) => /^a=rtpmap:(\d+)\s+opus\/48000/i.test(l));
      if (opusRtpLine) {
        const pt = opusRtpLine.match(/^a=rtpmap:(\d+)\s+opus\/48000/i)[1];
        const fmtpIndex = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt}`));
        const opusParams = 'minptime=10;ptime=20;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=48000;cbr=1;usedtx=0';
        if (fmtpIndex !== -1) {
          lines[fmtpIndex] = `a=fmtp:${pt} ${opusParams}`;
        } else {
          const rtpIndex = lines.indexOf(opusRtpLine);
          lines.splice(rtpIndex + 1, 0, `a=fmtp:${pt} ${opusParams}`);
        }
      }

      // 2. Video Optimization: Bandwidth Ceilings & Safe Offer Codec Ordering
      if (isVideo) {
        const mVideoIndex = lines.findIndex((l) => l.startsWith('m=video '));
        if (mVideoIndex !== -1) {
          // IMPORTANT: RFC 8829 / RFC 3264 strictly forbids re-ordering or changing
          // payload formats on an Answer SDP! Re-ordering is only permitted on Offers:
          if (!isAnswer) {
            const preferredPayloads = [];
            // Prefer VP8 for rock-solid zero-packet-drop mobile streaming without timestamp stutter
            lines.forEach((l) => {
              const m = l.match(/^a=rtpmap:(\d+)\s+VP8\/90000/i);
              if (m && !preferredPayloads.includes(m[1])) preferredPayloads.push(m[1]);
            });
            // 2. Hardware H264 with packetization-mode=1
            lines.forEach((l) => {
              const m = l.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
              if (m) {
                const pt = m[1];
                const fmtp = lines.find((line) => line.startsWith(`a=fmtp:${pt}`));
                if (!fmtp || fmtp.includes('packetization-mode=1')) {
                  if (!preferredPayloads.includes(pt)) preferredPayloads.push(pt);
                }
              }
            });

            if (preferredPayloads.length > 0) {
              const parts = lines[mVideoIndex].split(' ');
              if (parts.length > 3) {
                const prefix = parts.slice(0, 3);
                const pts = parts.slice(3);
                const remaining = pts.filter((p) => !preferredPayloads.includes(p));
                lines[mVideoIndex] = [...prefix, ...preferredPayloads, ...remaining].join(' ');
              }
            }
          }

          // Set 2.0 Mbps bandwidth ceiling for smooth mobile packet delivery
          const asLineIdx = lines.findIndex((l, idx) => idx > mVideoIndex && idx < mVideoIndex + 6 && l.startsWith('b=AS:'));
          if (asLineIdx !== -1) {
            lines[asLineIdx] = 'b=AS:2000';
          }
          const tiasLineIdx = lines.findIndex((l, idx) => idx > mVideoIndex && idx < mVideoIndex + 6 && l.startsWith('b=TIAS:'));
          if (tiasLineIdx !== -1) {
            lines[tiasLineIdx] = 'b=TIAS:2000000';
          }
          if (asLineIdx === -1 && tiasLineIdx === -1) {
            lines.splice(mVideoIndex + 1, 0, 'b=AS:2000', 'b=TIAS:2000000');
          }
        }
      }

      return lines.join('\r\n');
    } catch (err) {
      console.warn('optimizeSdp error, using raw SDP:', err);
      return sdp;
    }
  }

  // ─── RTCRtpSender Dynamic Bitrate & Adaptive Framerate ──────────────────────
  async function tuneSenderParameters(pc, type, targetVideoBitrate = 1800000) {
    if (!pc || !pc.getSenders) return;
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (!sender.track) continue;

        if (sender.track.kind === 'video' && type === 'video') {
          // Guard: avoid hardware encoder resets if parameters already configured
          if (sender._lastBitrate === targetVideoBitrate) continue;
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = targetVideoBitrate;
            params.encodings[0].minBitrate = 200000;
            params.encodings[0].maxFramerate = 30;
            params.encodings[0].scaleResolutionDownBy = 1.0;
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            params.degradationPreference = 'maintain-framerate';
            await sender.setParameters(params);
            sender._lastBitrate = targetVideoBitrate;
          } catch (e) {
            console.warn('Sender video tuning notice:', e.message);
          }
        } else if (sender.track.kind === 'audio') {
          // Tune audio sender ONLY ONCE per call to eliminate stutter/audio dropouts
          if (sender._audioTuned) continue;
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 48000;
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            if ('dtx' in params.encodings[0]) {
              params.encodings[0].dtx = 'disabled';
            }
            await sender.setParameters(params);
            sender._audioTuned = true;
          } catch (e) {
            console.warn('Sender audio tuning notice:', e.message);
          }
        }
      }
    } catch (err) {
      console.warn('tuneSenderParameters error:', err.message);
    }
  }

  // ─── Web Audio API Sound Synthesizer ────────────────────────────────────────
  let audioCtx = null;
  let activeOscillators = [];
  let ringInterval = null;

  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        audioCtx = new AudioCtxClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function stopAllTones() {
    if (ringInterval) {
      clearInterval(ringInterval);
      ringInterval = null;
    }
    activeOscillators.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch (e) {}
    });
    activeOscillators = [];
  }

  // Realistic outgoing dial tone (WhatsApp-style European dual-tone beep)
  function playDialTone() {
    stopAllTones();
    const ctx = getAudioContext();
    if (!ctx) return;

    function beep() {
      try {
        const now = ctx.currentTime;
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(440, now); // 440 Hz
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(480, now); // 480 Hz

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.08, now + 0.05);
        gain.gain.setValueAtTime(0.08, now + 1.2);
        gain.gain.linearRampToValueAtTime(0.001, now + 1.3);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 1.3);
        osc2.stop(now + 1.3);

        activeOscillators.push(osc1, osc2);
      } catch (e) {}
    }

    beep();
    ringInterval = setInterval(beep, 3000);
  }

  // Melodious WhatsApp-style incoming chime ringtone
  function playRingtone() {
    stopAllTones();
    const ctx = getAudioContext();
    if (!ctx) return;

    function chime() {
      try {
        const now = ctx.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 melody
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const startTime = now + idx * 0.16;

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, startTime);

          gain.gain.setValueAtTime(0.001, startTime);
          gain.gain.linearRampToValueAtTime(0.12, startTime + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(startTime);
          osc.stop(startTime + 0.38);
          activeOscillators.push(osc);
        });
      } catch (e) {}
    }

    chime();
    ringInterval = setInterval(chime, 2400);
  }

  // End-of-call 3 short beeps
  function playEndTone() {
    stopAllTones();
    const ctx = getAudioContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = now + i * 0.18;

        osc.type = 'sine';
        osc.frequency.setValueAtTime(480, start);

        gain.gain.setValueAtTime(0.09, start);
        gain.gain.setValueAtTime(0.001, start + 0.1);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(start);
        osc.stop(start + 0.12);
        activeOscillators.push(osc);
      }
    } catch (e) {}
  }

  // ─── Call Engine State ──────────────────────────────────────────────────────
  let callState = 'idle'; // 'idle' | 'calling' | 'ringing' | 'connected'
  let callType = 'audio'; // 'audio' | 'video'
  let peerConnection = null;
  let localStream = null;
  let remoteStream = null;
  let currentCallerId = null;
  let targetPartnerId = null;
  let currentFacingMode = 'user'; // 'user' | 'environment'
  let isAcceptingCall = false;
  let callTimerInterval = null;
  let callSecondsElapsed = 0;
  let pendingIceCandidates = [];
  let incomingCallTimeout = null;
  let iceDisconnectTimeout = null;
  let connectionFailedTimeout = null;
  let wakeLock = null;
  let remoteAudioStream = null;
  let remoteVideoStream = null;
  let statsMonitorInterval = null;
  let lastPacketsSent = 0;
  let lastPacketsLost = 0;
  let isRenegotiating = false;

  function getCurrentUserId() {
    let u = null;
    if (typeof window.getCurrentUser === 'function') {
      u = window.getCurrentUser();
    }
    if (!u) {
      try {
        const cached = localStorage.getItem('cached_user');
        if (cached) u = JSON.parse(cached);
      } catch (e) {}
    }
    return u?._id?.toString() || '';
  }

  // ─── DOM Elements ───────────────────────────────────────────────────────────
  const callActionBtn = document.getElementById('callActionBtn');
  const callChoiceDropdown = document.getElementById('callChoiceDropdown');
  const startVoiceCallBtn = document.getElementById('startVoiceCallBtn');
  const startVideoCallBtn = document.getElementById('startVideoCallBtn');

  // Modals
  const outgoingCallModal = document.getElementById('outgoingCallModal');
  const outgoingPartnerAvatar = document.getElementById('outgoingPartnerAvatar');
  const outgoingPartnerName = document.getElementById('outgoingPartnerName');
  const outgoingCallStatus = document.getElementById('outgoingCallStatus');
  const outgoingCallTypeLabel = document.getElementById('outgoingCallTypeLabel');
  const cancelOutgoingCallBtn = document.getElementById('cancelOutgoingCallBtn');

  const incomingCallModal = document.getElementById('incomingCallModal');
  const incomingCallerAvatar = document.getElementById('incomingCallerAvatar');
  const incomingCallerName = document.getElementById('incomingCallerName');
  const incomingCallStatus = document.getElementById('incomingCallStatus');
  const incomingCallTypeLabel = document.getElementById('incomingCallTypeLabel');
  const declineCallBtn = document.getElementById('declineCallBtn');
  const acceptCallBtn = document.getElementById('acceptCallBtn');

  const activeCallModal = document.getElementById('activeCallModal');
  const callVideoContainer = document.getElementById('callVideoContainer');
  const callAudioContainer = document.getElementById('callAudioContainer');
  const remoteVideoPlayer = document.getElementById('remoteVideoPlayer');
  const localVideoPlayer = document.getElementById('localVideoPlayer');
  const localVideoWrapper = document.getElementById('localVideoWrapper');
  const remoteAudioPlayer = document.getElementById('remoteAudioPlayer');
  const bgKeepAliveAudio = document.getElementById('bgKeepAliveAudio');
  const activeCallPartnerAvatar = document.getElementById('activeCallPartnerAvatar');
  const activeCallPartnerName = document.getElementById('activeCallPartnerName');
  const callDurationTimer = document.getElementById('callDurationTimer');

  // 1-second ultra-lightweight silent WAV to keep background audio session alive in Chrome/Android
  const SILENT_WAV_BASE64 = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  if (bgKeepAliveAudio) {
    bgKeepAliveAudio.src = SILENT_WAV_BASE64;
  }

  // Active call controls & Minimization
  let isSpeakerMode = true; // WhatsApp style speaker mode (defaults to loudspeaker)
  let isCallMinimized = false;
  let isVideoSwapped = false;

  const callMinimizeBtn = document.getElementById('callMinimizeBtn');
  const callSystemPipBtn = document.getElementById('callSystemPipBtn');
  const ongoingCallBanner = document.getElementById('ongoingCallBanner');
  const ongoingBannerIcon = document.getElementById('ongoingBannerIcon');
  const ongoingBannerMeta = document.getElementById('ongoingBannerMeta');
  const ongoingBannerEndBtn = document.getElementById('ongoingBannerEndBtn');

  const floatingCallPip = document.getElementById('floatingCallPip');
  const floatingPipVideo = document.getElementById('floatingPipVideo');
  const floatingPipTimer = document.getElementById('floatingPipTimer');

  const callToggleSpeakerBtn = document.getElementById('callToggleSpeakerBtn');
  const callSpeakerOnIcon = document.getElementById('callSpeakerOnIcon');
  const callSpeakerOffIcon = document.getElementById('callSpeakerOffIcon');
  const callSpeakerLabel = document.getElementById('callSpeakerLabel');
  const callToggleMicBtn = document.getElementById('callToggleMicBtn');
  const callMicOnIcon = document.getElementById('callMicOnIcon');
  const callMicOffIcon = document.getElementById('callMicOffIcon');
  const callFlipCameraBtn = document.getElementById('callFlipCameraBtn');
  const callToggleVideoBtn = document.getElementById('callToggleVideoBtn');
  const callVideoOnIcon = document.getElementById('callVideoOnIcon');
  const callVideoOffIcon = document.getElementById('callVideoOffIcon');
  const endActiveCallBtn = document.getElementById('endActiveCallBtn');

  // ─── Partner & Current User Detection ───────────────────────────────────────
  function getPartnerInfo() {
    let p = null;
    if (typeof window.getCurrentPartner === 'function') {
      p = window.getCurrentPartner();
    }
    if (!p) {
      try {
        const cached = localStorage.getItem('cached_partner');
        if (cached) p = JSON.parse(cached);
      } catch (e) {}
    }
    const nameEl = document.getElementById('partnerName');
    const avatarEl = document.getElementById('partnerAvatar');
    const avatarImg = avatarEl ? avatarEl.querySelector('img') : null;

    return {
      _id: p?._id || null,
      displayName: p?.displayName || nameEl?.textContent?.trim() || 'Partner',
      profileImage: p?.profileImage || avatarImg?.src || null,
    };
  }

  // ─── Helpers: UI & Modal Visibility ─────────────────────────────────────────
  function showModal(modal) {
    if (!modal) return;
    modal.classList.add('active');
    modal.style.removeProperty('display');
  }

  function hideModal(modal) {
    if (!modal) return;
    modal.classList.remove('active');
    modal.style.removeProperty('display');
  }

  function toggleCallDropdown(show) {
    if (!callChoiceDropdown) return;
    const isShown = callChoiceDropdown.classList.contains('show');
    const shouldShow = typeof show === 'boolean' ? show : !isShown;
    if (shouldShow) {
      callChoiceDropdown.classList.add('show');
    } else {
      callChoiceDropdown.classList.remove('show');
    }
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      const remainMins = mins % 60;
      return `${pad(hrs)}:${pad(remainMins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }

  function startDurationTimer() {
    stopDurationTimer();
    callSecondsElapsed = 0;
    const initialFormatted = '00:00';
    if (callDurationTimer) callDurationTimer.textContent = initialFormatted;
    if (floatingPipTimer) floatingPipTimer.textContent = initialFormatted;
    const partner = getPartnerInfo();
    if (ongoingBannerMeta) {
      ongoingBannerMeta.textContent = `${partner.displayName} • ${initialFormatted}`;
    }

    callTimerInterval = setInterval(() => {
      callSecondsElapsed++;
      const formatted = formatDuration(callSecondsElapsed);
      if (callDurationTimer) {
        callDurationTimer.textContent = formatted;
      }
      if (ongoingBannerMeta) {
        const curPartner = getPartnerInfo();
        ongoingBannerMeta.textContent = `${curPartner.displayName} • ${formatted}`;
      }
      if (floatingPipTimer) {
        floatingPipTimer.textContent = formatted;
      }
    }, 1000);
  }

  function stopDurationTimer() {
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
  }

  function applyAvatarToImg(imgEl, avatarUrl, fallbackText) {
    if (!imgEl) return;
    if (avatarUrl && !avatarUrl.includes('favicon.ico')) {
      imgEl.src = avatarUrl;
    } else {
      // Create SVG inline avatar with initial
      const initial = (fallbackText || 'P').charAt(0).toUpperCase();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100%" height="100%" fill="%238b5cf6"/><text x="50%" y="54%" font-size="44" font-family="Arial,sans-serif" font-weight="bold" fill="%23ffffff" dominant-baseline="middle" text-anchor="middle">${initial}</text></svg>`;
      imgEl.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
  }

  // Default 1x camera constraints matching standard mobile camera
  function getVideoConstraints() {
    return {
      facingMode: currentFacingMode || 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
  }

  // ─── Local Media Acquisition (Adaptive HD with Graceful Fallback) ─────────
  async function acquireLocalStream(type) {
    if (localStream && localStream.active) {
      const hasAudio = localStream.getAudioTracks().some((t) => t.readyState === 'live');
      const hasVideo = localStream.getVideoTracks().some((t) => t.readyState === 'live');
      if (hasAudio && (type !== 'video' || hasVideo)) {
        return localStream;
      }
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    const videoConstraints = getVideoConstraints();

    let stream = null;

    // Multi-tier acquisition with bulletproof fallbacks
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: type === 'video' ? videoConstraints : false,
      });
    } catch (err1) {
      console.warn('Initial camera/audio constraints failed, attempting relaxed constraints...', err1);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: type === 'video' ? { facingMode: currentFacingMode || 'user' } : false,
        });
      } catch (err2) {
        console.warn('Relaxed constraints failed, attempting basic constraints...', err2);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: type === 'video',
          });
        } catch (err3) {
          if (type === 'video') {
            console.warn('Video acquisition failed, falling back to audio-only to prevent call drop...', err3);
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              if (window.UI?.showToast) {
                window.UI.showToast('Camera unavailable, joined with audio.', 'info');
              }
            } catch (err4) {
              console.error('All media acquisition failed:', err4);
              if (window.UI?.showToast) {
                window.UI.showToast('Microphone / Camera access denied or unavailable.', 'error');
              }
              throw err4;
            }
          } else {
            console.error('Audio acquisition failed:', err3);
            if (window.UI?.showToast) {
              window.UI.showToast('Microphone access denied or unavailable.', 'error');
            }
            throw err3;
          }
        }
      }
    }

    localStream = stream;

    // Speech content hint for optimal vocal clarity
    const aTrack = stream.getAudioTracks()[0];
    if (aTrack && 'contentHint' in aTrack) {
      aTrack.contentHint = 'speech';
    }

    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) {
      if ('contentHint' in vTrack) {
        vTrack.contentHint = 'motion';
      }
      // Reset hardware/OEM camera zoom to minimum (1.0x wide field of view, no crop)
      try {
        if (typeof vTrack.getCapabilities === 'function') {
          const caps = vTrack.getCapabilities();
          if (caps && 'zoom' in caps) {
            const minZ = (caps.zoom && typeof caps.zoom.min === 'number') ? caps.zoom.min : 1;
            vTrack.applyConstraints({ advanced: [{ zoom: minZ }] }).catch(() => {});
          }
        }
      } catch (e) {}
    }

    // Bind to local video player if video call
    if (type === 'video' && localVideoPlayer && stream.getVideoTracks().length > 0) {
      localVideoPlayer.srcObject = stream;
      localVideoPlayer.muted = true;
      localVideoPlayer.playsInline = true;
      if (currentFacingMode === 'user') {
        localVideoPlayer.classList.add('mirror');
      } else {
        localVideoPlayer.classList.remove('mirror');
      }
      localVideoPlayer.play().catch(() => {});
    }
    return stream;
  }

  // ─── WebRTC Peer Connection Setup ───────────────────────────────────────────
  function createPeerConnection(targetId) {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnection = pc;

    // Attach local stream tracks to PC
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    // Set video codec preference (Hardware H.264 FIRST for stutter-free 30fps hardware encoding, then VP8)
    try {
      const videoTransceiver = pc.getTransceivers().find(
        (t) => t.sender && t.sender.track && t.sender.track.kind === 'video'
      );
      if (videoTransceiver && typeof RTCRtpSender.getCapabilities === 'function') {
        const capabilities = RTCRtpSender.getCapabilities('video');
        if (capabilities && capabilities.codecs) {
          const h264Codecs = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
          const vp8Codecs = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp8');
          const otherCodecs = capabilities.codecs.filter(
            (c) => c.mimeType.toLowerCase() !== 'video/h264' && c.mimeType.toLowerCase() !== 'video/vp8'
          );
          if (typeof videoTransceiver.setCodecPreferences === 'function') {
            videoTransceiver.setCodecPreferences([...vp8Codecs, ...h264Codecs, ...otherCodecs]);
          }
        }
      }
    } catch (e) {}

    // ICE Candidate handler -> send via socket
    pc.onicecandidate = (event) => {
      if (event.candidate && window.ChatSocket) {
        window.ChatSocket.emit('ice_candidate', {
          targetUserId: targetId || targetPartnerId || currentCallerId,
          candidate: event.candidate,
        });
      }
    };

    // Remote Track handler — Unified MediaStream for native WebRTC Lip-Sync, adaptive jitter buffer
    pc.ontrack = (event) => {
      console.log('📡 Remote track received:', event.track.kind);
      if (!remoteStream) {
        remoteStream = new MediaStream();
      }
      if (!remoteStream.getTrackById(event.track.id)) {
        remoteStream.addTrack(event.track);
      }

      // When a remote track ends (e.g. camera flipped/toggled), do NOT end the call!
      event.track.onended = () => {
        console.log('📡 Remote track ended:', event.track.kind);
        if (event.track.kind === 'video') {
          if (remoteVideoPlayer) {
            remoteVideoPlayer.srcObject = null;
          }
          applyVideoStreamsToPlayers();
        }
      };

      if (event.track.kind === 'audio') {
        if (!remoteAudioStream) {
          remoteAudioStream = new MediaStream();
        }
        remoteAudioStream.getAudioTracks().forEach((t) => {
          if (t.id !== event.track.id) remoteAudioStream.removeTrack(t);
        });
        if (!remoteAudioStream.getTrackById(event.track.id)) {
          remoteAudioStream.addTrack(event.track);
        }

        if (callType === 'audio') {
          if (remoteAudioPlayer) {
            if (remoteAudioPlayer.srcObject !== remoteStream) {
              remoteAudioPlayer.srcObject = remoteStream;
            }
            remoteAudioPlayer.muted = false;
            remoteAudioPlayer.volume = isSpeakerMode ? 1.0 : 0.45;
            remoteAudioPlayer.playsInline = true;
            remoteAudioPlayer.play().catch((err) => console.warn('remoteAudioPlayer play() failed:', err));
          }
        } else {
          // In video calls, sync video with audio directly via remoteVideoPlayer for A/V Lip-Sync
          applyVideoStreamsToPlayers();
        }
      } else if (event.track.kind === 'video') {
        if (!remoteVideoStream) {
          remoteVideoStream = new MediaStream();
        }
        remoteVideoStream.getVideoTracks().forEach((t) => {
          if (t.id !== event.track.id) remoteVideoStream.removeTrack(t);
        });
        if (!remoteVideoStream.getTrackById(event.track.id)) {
          remoteVideoStream.addTrack(event.track);
        }

        event.track.onunmute = () => {
          console.log('🎥 Remote video track unmuted and streaming');
          applyVideoStreamsToPlayers();
        };

        applyVideoStreamsToPlayers();
      }

      applySpeakerState();
    };

    // Connection state changes with automatic ICE restart recovery
    pc.onconnectionstatechange = () => {
      console.log('🔄 WebRTC connectionState:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (connectionFailedTimeout) {
          clearTimeout(connectionFailedTimeout);
          connectionFailedTimeout = null;
        }
        tuneSenderParameters(pc, callType);
        transitionToConnected();
      } else if (pc.connectionState === 'failed') {
        console.warn('⚠️ WebRTC connectionState failed, attempting ICE restart before ending...');
        triggerIceRestart('connectionState failed');
        if (!connectionFailedTimeout) {
          connectionFailedTimeout = setTimeout(() => {
            if (pc.connectionState === 'failed' && callState === 'connected') {
              console.error('❌ Connection recovery timed out, closing call.');
              endCall(false, 'Connection lost');
            }
          }, 10000);
        }
      } else if (pc.connectionState === 'closed') {
        if (callState === 'connected') {
          endCall(false, 'Call closed');
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('📶 ICE Connection State:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (iceDisconnectTimeout) {
          clearTimeout(iceDisconnectTimeout);
          iceDisconnectTimeout = null;
        }
        if (connectionFailedTimeout) {
          clearTimeout(connectionFailedTimeout);
          connectionFailedTimeout = null;
        }
        tuneSenderParameters(pc, callType);
      } else if (pc.iceConnectionState === 'disconnected') {
        console.warn('⚠️ ICE momentarily disconnected, waiting for network recovery...');
        if (!iceDisconnectTimeout) {
          iceDisconnectTimeout = setTimeout(() => {
            if (pc.iceConnectionState === 'disconnected' && callState === 'connected') {
              console.log('🔄 Triggering ICE restart after 6s network disconnect...');
              triggerIceRestart('ICE disconnected 6s');
            }
          }, 6000);
        }
      } else if (pc.iceConnectionState === 'failed') {
        console.warn('⚠️ ICE failed, triggering immediate ICE restart...');
        triggerIceRestart('ICE state failed');
      }
    };

    return pc;
  }

  // ─── Call Initiation (Outgoing) ─────────────────────────────────────────────
  async function initiateCall(type) {
    if (callState !== 'idle') return;
    toggleCallDropdown(false);

    const partner = getPartnerInfo();
    targetPartnerId = partner._id;
    callType = type;
    pendingIceCandidates = [];
    callType = type;

    // Check if partner is known
    applyAvatarToImg(outgoingPartnerAvatar, partner.profileImage, partner.displayName);
    if (outgoingPartnerName) outgoingPartnerName.textContent = partner.displayName;
    if (outgoingCallStatus) outgoingCallStatus.textContent = 'Connecting...';
    if (outgoingCallTypeLabel) {
      outgoingCallTypeLabel.textContent = type === 'video' ? '📹 WhatsApp Video Call' : '📞 WhatsApp Voice Call';
    }

    // Show Outgoing Modal
    callState = 'calling';
    if (outgoingCallModal) showModal(outgoingCallModal);
    playDialTone();

    try {
      await acquireLocalStream(type);
      const pc = createPeerConnection(targetPartnerId);

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video',
      });
      let finalOffer = offer;
      try {
        const optimizedSdp = optimizeSdp(offer.sdp, type === 'video', false);
        finalOffer = new RTCSessionDescription({ type: offer.type, sdp: optimizedSdp });
        await pc.setLocalDescription(finalOffer);
      } catch (sdpErr) {
        console.warn('Optimized offer SDP rejected, using raw offer:', sdpErr);
        finalOffer = offer;
        await pc.setLocalDescription(offer);
      }
      await tuneSenderParameters(pc, type);

      if (outgoingCallStatus) outgoingCallStatus.textContent = 'Calling...';

      // Emit call_user to server
      if (window.ChatSocket) {
        window.ChatSocket.emit(
          'call_user',
          { callType: type, offer: finalOffer },
          (response) => {
            if (response?.error) {
              stopAllTones();
              playEndTone();
              if (outgoingCallStatus) outgoingCallStatus.textContent = response.error;
              setTimeout(() => {
                cleanupCallState();
                if (window.UI?.showToast) {
                  window.UI.showToast(response.error, 'info');
                }
              }, 1800);
            }
          }
        );
      }
    } catch (err) {
      console.error('initiateCall failed:', err);
      stopAllTones();
      cleanupCallState();
    }
  }

  // ─── Incoming Call Handling ─────────────────────────────────────────────────
  let incomingOfferData = null;

  function handleIncomingCall(data) {
    if (!data) return;
    const { callerId, callerName, callerAvatar, callType: incomingType, offer } = data;

    // WhatsApp-Style Simultaneous Calling Resolution (Glare tie-breaker)
    // If both users call each other at the exact same moment:
    if (callState === 'calling') {
      const myId = getCurrentUserId();
      const otherId = callerId ? callerId.toString() : '';
      console.log('🔄 Simultaneous call detected! MyId:', myId, 'OtherId:', otherId);

      // Deterministic tie-breaker:
      // Larger user ID yields outgoing call, adopts incoming offer, and immediately answers!
      if (myId && otherId && myId.localeCompare(otherId) > 0) {
        console.log('🔄 Yielding outgoing call to auto-answer partner simultaneous call');
        stopAllTones();
        if (outgoingCallModal) hideModal(outgoingCallModal);

        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
        if (localStream) {
          localStream.getTracks().forEach((t) => t.stop());
          localStream = null;
        }

        callState = 'ringing';
        callType = incomingType || callType;
        currentCallerId = callerId;
        incomingOfferData = offer;
        acceptIncomingCall();
        return;
      } else {
        console.log('🔄 Maintaining outgoing call as primary caller; partner is auto-answering');
        return;
      }
    }

    // If currently busy in an active connected call, reject
    if (callState !== 'idle') {
      if (window.ChatSocket) {
        window.ChatSocket.emit('call_rejected', { callerId, reason: 'busy' });
      }
      return;
    }

    callState = 'ringing';
    callType = incomingType || 'audio';
    currentCallerId = callerId;
    incomingOfferData = offer;

    // Populate incoming modal UI
    applyAvatarToImg(incomingCallerAvatar, callerAvatar, callerName);
    if (incomingCallerName) incomingCallerName.textContent = callerName || 'Partner';
    if (incomingCallStatus) {
      incomingCallStatus.textContent =
        incomingType === 'video' ? 'Incoming WhatsApp Video Call...' : 'Incoming WhatsApp Voice Call...';
    }
    if (incomingCallTypeLabel) {
      incomingCallTypeLabel.textContent =
        incomingType === 'video' ? '📹 WhatsApp Video Call' : '📞 WhatsApp Voice Call';
    }

    if (incomingCallModal) showModal(incomingCallModal);
    playRingtone();

    // Signal caller that phone is ringing
    if (window.ChatSocket) {
      window.ChatSocket.emit('call_ringing', { callerId });
    }

    // Auto-timeout after 40s (missed call)
    if (incomingCallTimeout) clearTimeout(incomingCallTimeout);
    incomingCallTimeout = setTimeout(() => {
      if (callState === 'ringing') {
        declineIncomingCall('no_answer');
      }
    }, 40000);
  }

  // Accept incoming call
  async function acceptIncomingCall() {
    if (callState !== 'ringing' || !incomingOfferData || isAcceptingCall) return;
    isAcceptingCall = true;
    stopAllTones();
    if (incomingCallTimeout) clearTimeout(incomingCallTimeout);

    try {
      await acquireLocalStream(callType);
      const pc = createPeerConnection(currentCallerId);

      await pc.setRemoteDescription(new RTCSessionDescription(incomingOfferData));

      // Flush any queued ICE candidates
      while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((e) => console.warn(e));
      }

      const answer = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: callType === 'video',
      });

      let finalAnswer = answer;
      try {
        const optimizedAnswerSdp = optimizeSdp(answer.sdp, callType === 'video', true);
        finalAnswer = new RTCSessionDescription({ type: answer.type, sdp: optimizedAnswerSdp });
        await pc.setLocalDescription(finalAnswer);
      } catch (sdpErr) {
        console.warn('Optimized answer SDP rejected, falling back to raw browser answer:', sdpErr);
        finalAnswer = answer;
        await pc.setLocalDescription(answer);
      }

      await tuneSenderParameters(pc, callType);

      if (window.ChatSocket) {
        window.ChatSocket.emit('call_accepted', {
          callerId: currentCallerId,
          answer: finalAnswer,
        });
      }

      transitionToConnected();
    } catch (err) {
      console.error('acceptIncomingCall error:', err);
      if (window.UI?.showToast) {
        window.UI.showToast('Could not answer call: ' + (err.message || 'Media/Connection error'), 'error');
      }
      declineIncomingCall('error');
    } finally {
      isAcceptingCall = false;
    }
  }

  // Decline incoming call
  function declineIncomingCall(reason = 'declined') {
    if (incomingCallTimeout) clearTimeout(incomingCallTimeout);
    stopAllTones();

    if (currentCallerId && window.ChatSocket) {
      window.ChatSocket.emit('call_rejected', {
        callerId: currentCallerId,
        reason,
      });
    }

    cleanupCallState();
  }

  // Cancel outgoing call
  function cancelOutgoingCall() {
    stopAllTones();
    playEndTone();

    if (window.ChatSocket) {
      window.ChatSocket.emit('call_ended', {
        targetUserId: targetPartnerId,
        durationSec: 0,
        callType,
      });
    }

    cleanupCallState();
  }

  // ─── Connection Transition & Active Call UI ─────────────────────────────────
  function transitionToConnected() {
    if (callState === 'connected') return;
    callState = 'connected';
    stopAllTones();
    if (incomingCallTimeout) clearTimeout(incomingCallTimeout);

    // Hide outgoing and incoming modals
    if (outgoingCallModal) hideModal(outgoingCallModal);
    if (incomingCallModal) hideModal(incomingCallModal);

    // Show Active Call Modal
    if (activeCallModal) {
      showModal(activeCallModal);
      activeCallModal.classList.remove('controls-hidden');
    }
    resetPipPosition();

    // Reset minimized state and banner/floating PiP
    isCallMinimized = false;
    isVideoSwapped = false;
    if (ongoingCallBanner) ongoingCallBanner.style.display = 'none';
    if (floatingCallPip) floatingCallPip.style.display = 'none';

    // Setup active call UI based on type
    const partner = getPartnerInfo();
    applyAvatarToImg(activeCallPartnerAvatar, partner.profileImage, partner.displayName);
    if (activeCallPartnerName) activeCallPartnerName.textContent = partner.displayName;

    if (callType === 'video') {
      if (callVideoContainer) callVideoContainer.style.display = 'block';
      if (callAudioContainer) callAudioContainer.style.display = 'none';
      if (callFlipCameraBtn) callFlipCameraBtn.style.display = 'inline-flex';
      if (callToggleVideoBtn) callToggleVideoBtn.style.display = 'inline-flex';
      if (callSystemPipBtn) {
        const canPiP = Boolean(
          document.pictureInPictureEnabled ||
          (remoteVideoPlayer && typeof remoteVideoPlayer.requestPictureInPicture === 'function')
        );
        callSystemPipBtn.style.display = canPiP ? 'inline-flex' : 'none';
      }
      applyVideoStreamsToPlayers();
    } else {
      if (callVideoContainer) callVideoContainer.style.display = 'none';
      if (callAudioContainer) callAudioContainer.style.display = 'flex';
      if (callFlipCameraBtn) callFlipCameraBtn.style.display = 'none';
      if (callToggleVideoBtn) callToggleVideoBtn.style.display = 'none';
      if (callSystemPipBtn) callSystemPipBtn.style.display = 'none';
      if (remoteAudioPlayer && remoteStream) {
        if (remoteAudioPlayer.srcObject !== remoteStream) {
          remoteAudioPlayer.srcObject = remoteStream;
        }
        remoteAudioPlayer.muted = false;
        remoteAudioPlayer.volume = isSpeakerMode ? 1.0 : 0.45;
        remoteAudioPlayer.playsInline = true;
        remoteAudioPlayer.play().catch(() => {});
      }
      if (remoteVideoPlayer) {
        remoteVideoPlayer.srcObject = null;
      }
    }

    // Reset controls state & apply speaker state
    resetControlsUI();
    applySpeakerState();
    startDurationTimer();
    startStatsMonitor(peerConnection);

    // Start silent audio keep-alive to prevent Android OS from killing mic/audio in background
    if (bgKeepAliveAudio) {
      bgKeepAliveAudio.play().catch(() => {});
    }
    // Update Android MediaSession for background calling notification
    updateMediaSession(partner);
    // Request Screen Wake Lock
    requestWakeLock();

    // Push history state so back button minimizes call instead of leaving page
    try {
      window.history.pushState({ callingModalOpen: true }, '');
    } catch (e) {}
  }

  // ─── Video Stream Assignment & Tap-to-Swap (WhatsApp Style) ────────────────
  function applyVideoStreamsToPlayers() {
    if (callType !== 'video') return;

    if (!isVideoSwapped) {
      // Normal Mode: Partner is Full Screen with unified Audio+Video for Lip-Sync
      if (remoteVideoPlayer) {
        if (remoteStream && remoteVideoPlayer.srcObject !== remoteStream) {
          remoteVideoPlayer.srcObject = remoteStream;
        }
        remoteVideoPlayer.muted = false;
        remoteVideoPlayer.volume = isSpeakerMode ? 1.0 : 0.45;
        remoteVideoPlayer.playsInline = true;
        remoteVideoPlayer.classList.remove('mirror');
        if (remoteVideoPlayer.paused) {
          remoteVideoPlayer.play().catch(() => {});
        }
      }

      // Local camera in PiP (muted, WhatsApp rounded cover)
      if (localVideoPlayer) {
        if (localStream && localVideoPlayer.srcObject !== localStream) {
          localVideoPlayer.srcObject = localStream;
        }
        localVideoPlayer.muted = true;
        localVideoPlayer.playsInline = true;
        localVideoPlayer.classList.toggle('mirror', currentFacingMode === 'user');
        localVideoPlayer.style.objectFit = 'cover';
        if (localVideoPlayer.paused) {
          localVideoPlayer.play().catch(() => {});
        }
      }

      // Standalone audio player is paused/muted to prevent double-audio
      if (remoteAudioPlayer) {
        remoteAudioPlayer.muted = true;
        remoteAudioPlayer.pause();
      }
    } else {
      // Swapped Mode: Local camera is Full Screen (muted)
      if (remoteVideoPlayer) {
        if (localStream && remoteVideoPlayer.srcObject !== localStream) {
          remoteVideoPlayer.srcObject = localStream;
        }
        remoteVideoPlayer.muted = true;
        remoteVideoPlayer.playsInline = true;
        remoteVideoPlayer.classList.toggle('mirror', currentFacingMode === 'user');
        if (remoteVideoPlayer.paused) {
          remoteVideoPlayer.play().catch(() => {});
        }
      }

      // Partner camera in PiP (muted)
      if (localVideoPlayer) {
        if (remoteStream && localVideoPlayer.srcObject !== remoteStream) {
          localVideoPlayer.srcObject = remoteStream;
        }
        localVideoPlayer.muted = true;
        localVideoPlayer.playsInline = true;
        localVideoPlayer.classList.remove('mirror');
        localVideoPlayer.style.objectFit = 'cover';
        if (localVideoPlayer.paused) {
          localVideoPlayer.play().catch(() => {});
        }
      }

      // Partner audio routed via remoteAudioPlayer
      if (remoteAudioPlayer && remoteStream) {
        if (remoteAudioPlayer.srcObject !== remoteStream) {
          remoteAudioPlayer.srcObject = remoteStream;
        }
        remoteAudioPlayer.muted = false;
        remoteAudioPlayer.volume = isSpeakerMode ? 1.0 : 0.45;
        remoteAudioPlayer.playsInline = true;
        if (remoteAudioPlayer.paused) {
          remoteAudioPlayer.play().catch(() => {});
        }
      }
    }

    // If floating PiP is active, ensure it displays remote video
    if (floatingCallPip && floatingCallPip.style.display !== 'none' && floatingPipVideo) {
      const pipTarget = remoteStream;
      if (pipTarget && floatingPipVideo.srcObject !== pipTarget) {
        floatingPipVideo.srcObject = pipTarget;
      }
      floatingPipVideo.muted = true;
      floatingPipVideo.playsInline = true;
      if (floatingPipVideo.paused) {
        floatingPipVideo.play().catch(() => {});
      }
    }
  }

  function toggleVideoSwap() {
    if (callType !== 'video' || callState !== 'connected') return;
    isVideoSwapped = !isVideoSwapped;
    applyVideoStreamsToPlayers();
    if (window.UI?.showToast) {
      window.UI.showToast(
        isVideoSwapped ? 'Swapped: Your camera is full screen' : 'Swapped: Partner is full screen',
        'info',
        1300
      );
    }
  }

  // ─── Call Minimization & Ongoing Banner (WhatsApp Style) ───────────────────
  function minimizeCall() {
    if (callState !== 'connected' || isCallMinimized) return;
    isCallMinimized = true;

    // 1. Hide active call modal
    if (activeCallModal) {
      hideModal(activeCallModal);
    }

    // 2. Show ongoing top banner above chat header
    const partner = getPartnerInfo();
    const formatted = formatDuration(callSecondsElapsed);
    if (ongoingBannerMeta) {
      ongoingBannerMeta.textContent = `${partner.displayName} • ${formatted}`;
    }
    if (ongoingBannerIcon) {
      ongoingBannerIcon.textContent = callType === 'video' ? '📹' : '📞';
    }
    if (ongoingCallBanner) {
      ongoingCallBanner.style.display = 'flex';
    }

    // 3. In video call, show floating draggable PiP over chat display
    if (callType === 'video' && floatingCallPip) {
      floatingCallPip.style.display = 'block';
      if (floatingPipVideo && remoteStream) {
        floatingPipVideo.srcObject = remoteStream;
        floatingPipVideo.muted = true;
        floatingPipVideo.playsInline = true;
        floatingPipVideo.play().catch(() => {});
      }
      if (floatingPipTimer) {
        floatingPipTimer.textContent = formatted;
      }
      resetFloatingPipPosition();
    }

    if (window.UI?.showToast) {
      window.UI.showToast(
        callType === 'video' ? 'Video call running in background' : 'Voice call running in background',
        'info',
        1500
      );
    }
  }

  function restoreCallFullscreen() {
    if (callState !== 'connected' || !isCallMinimized) return;
    isCallMinimized = false;

    // 1. Hide ongoing banner and floating PiP
    if (ongoingCallBanner) {
      ongoingCallBanner.style.display = 'none';
    }
    if (floatingCallPip) {
      floatingCallPip.style.display = 'none';
    }

    // 2. Show active call modal
    if (activeCallModal) {
      showModal(activeCallModal);
      activeCallModal.classList.remove('controls-hidden');
    }

    // 3. Re-apply correct video streams
    applyVideoStreamsToPlayers();

    // 4. Push history state so back button will minimize again
    try {
      window.history.pushState({ callingModalOpen: true }, '');
    } catch (e) {}
  }

  // ─── Native OS-Level System Picture-in-Picture (Over Other Apps) ───────────
  async function toggleSystemPictureInPicture() {
    if (callType !== 'video' || callState !== 'connected') return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }

      if (remoteVideoPlayer) {
        if (remoteVideoPlayer.readyState < 2) {
          await remoteVideoPlayer.play().catch(() => {});
        }
        await remoteVideoPlayer.requestPictureInPicture();
        if (window.UI?.showToast) {
          window.UI.showToast('Floating window active over other apps 📱', 'success', 2200);
        }
      }
    } catch (err) {
      console.warn('System Picture-in-Picture request failed:', err);
      // Fallback: minimize inside chat app
      minimizeCall();
      if (window.UI?.showToast) {
        window.UI.showToast('Floating window active in chat', 'info', 1800);
      }
    }
  }

  function resetControlsUI() {
    if (callToggleMicBtn) callToggleMicBtn.classList.remove('btn-muted');
    if (callMicOnIcon) callMicOnIcon.style.display = 'block';
    if (callMicOffIcon) callMicOffIcon.style.display = 'none';

    if (callToggleVideoBtn) callToggleVideoBtn.classList.remove('btn-muted');
    if (callVideoOnIcon) callVideoOnIcon.style.display = 'block';
    if (callVideoOffIcon) callVideoOffIcon.style.display = 'none';
  }

  // ─── MediaSession & WakeLock for Background Calling ─────────────────────────
  function updateMediaSession(partner) {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: callType === 'video' ? '📹 WhatsApp Video Call' : '📞 WhatsApp Voice Call',
          artist: partner?.displayName || 'Partner',
          album: 'Background Voice Active',
          artwork: [
            { src: partner?.profileImage || '/favicon.ico', sizes: '192x192', type: 'image/png' },
          ],
        });
        navigator.mediaSession.playbackState = 'playing';

        navigator.mediaSession.setActionHandler('hangup', () => {
          endCall(true);
        });
        navigator.mediaSession.setActionHandler('stop', () => {
          endCall(true);
        });
      } catch (e) {
        console.warn('mediaSession error:', e);
      }
    }
  }

  function releaseMediaSession() {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'none';
      } catch (e) {}
    }
  }

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {}
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ─── Speaker Output Toggle (WhatsApp Style Loudspeaker vs Earpiece) ─────────
  async function toggleSpeaker() {
    isSpeakerMode = !isSpeakerMode;
    await applySpeakerState();
    if (window.UI?.showToast) {
      window.UI.showToast(isSpeakerMode ? 'Speaker ON 🔊' : 'Earpiece Mode 🔈', 'info', 1400);
    }
  }

  function applySpeakerState() {
    if (callToggleSpeakerBtn) {
      callToggleSpeakerBtn.classList.toggle('speaker-on', isSpeakerMode);
    }
    if (callSpeakerOnIcon) callSpeakerOnIcon.style.display = isSpeakerMode ? 'block' : 'none';
    if (callSpeakerOffIcon) callSpeakerOffIcon.style.display = isSpeakerMode ? 'none' : 'block';
    if (callSpeakerLabel) callSpeakerLabel.textContent = isSpeakerMode ? 'Speaker' : 'Earpiece';

    const callVol = isSpeakerMode ? 1.0 : 0.45;
    if (remoteAudioPlayer) {
      remoteAudioPlayer.volume = callVol;
    }
    if (remoteVideoPlayer) {
      remoteVideoPlayer.volume = callVol;
    }
  }

  // ─── In-Call Controls ───────────────────────────────────────────────────────
  // Mic mute/unmute
  function toggleMicrophone() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    const isMuted = !audioTrack.enabled;

    if (callToggleMicBtn) {
      callToggleMicBtn.classList.toggle('btn-muted', isMuted);
    }
    if (callMicOnIcon) callMicOnIcon.style.display = isMuted ? 'none' : 'block';
    if (callMicOffIcon) callMicOffIcon.style.display = isMuted ? 'block' : 'none';

    if (window.UI?.showToast) {
      window.UI.showToast(isMuted ? 'Microphone muted 🔇' : 'Microphone unmuted 🎙️', 'info', 1200);
    }
  }

  // Video track on/off
  function toggleVideoCamera() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;
    const isOff = !videoTrack.enabled;

    if (callToggleVideoBtn) {
      callToggleVideoBtn.classList.toggle('btn-muted', isOff);
    }
    if (callVideoOnIcon) callVideoOnIcon.style.display = isOff ? 'none' : 'block';
    if (callVideoOffIcon) callVideoOffIcon.style.display = isOff ? 'block' : 'none';

    if (localVideoPlayer) {
      localVideoPlayer.style.opacity = isOff ? '0.2' : '1';
    }
  }

  // Flip camera (front <-> rear)
  async function flipCamera() {
    if (!localStream || !peerConnection) return;
    const currentVideoTrack = localStream.getVideoTracks()[0];
    if (!currentVideoTrack) return;

    try {
      currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

      let newStream = null;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: getVideoConstraints(),
        });
      } catch (e) {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode },
        });
      }

      const newVideoTrack = newStream.getVideoTracks()[0];
      if (newVideoTrack) {
        if ('contentHint' in newVideoTrack) {
          newVideoTrack.contentHint = 'motion';
        }
        try {
          if (typeof newVideoTrack.getCapabilities === 'function') {
            const caps = newVideoTrack.getCapabilities();
            if (caps && 'zoom' in caps) {
              const minZ = (caps.zoom && typeof caps.zoom.min === 'number') ? caps.zoom.min : 1;
              newVideoTrack.applyConstraints({ advanced: [{ zoom: minZ }] }).catch(() => {});
            }
          }
        } catch (_) {}
      }

      // Replace track on sender
      const senders = peerConnection.getSenders();
      const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(newVideoTrack);
      }

      // Stop old track
      currentVideoTrack.stop();
      localStream.removeTrack(currentVideoTrack);
      localStream.addTrack(newVideoTrack);

      applyVideoStreamsToPlayers();
    } catch (err) {
      console.warn('flipCamera failed:', err);
    }
  }

  // End active call
  function endCall(sendSignal = true, customMsg = null) {
    const elapsed = callSecondsElapsed;
    stopDurationTimer();
    stopAllTones();
    playEndTone();

    if (sendSignal && window.ChatSocket) {
      window.ChatSocket.emit('call_ended', {
        targetUserId: targetPartnerId || currentCallerId,
        durationSec: elapsed,
        callType,
      });
    }

    cleanupCallState();

    if (window.UI?.showToast) {
      const msg = customMsg || (elapsed > 0 ? `Call ended (${formatDuration(elapsed)})` : 'Call ended');
      window.UI.showToast(msg, 'info', 2500);
    }
  }

  // ─── Teardown & Reset ───────────────────────────────────────────────────────

  function cleanupCallState() {
    callState = 'idle';
    incomingOfferData = null;
    currentCallerId = null;
    targetPartnerId = null;
    pendingIceCandidates = [];
    currentFacingMode = 'user';
    isCallMinimized = false;
    isVideoSwapped = false;
    isAcceptingCall = false;

    stopDurationTimer();
    stopStatsMonitor();
    stopAllTones();
    isRenegotiating = false;

    if (incomingCallTimeout) {
      clearTimeout(incomingCallTimeout);
      incomingCallTimeout = null;
    }

    // Stop local tracks
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
      remoteStream = null;
    }

    if (remoteAudioStream) {
      remoteAudioStream.getTracks().forEach((track) => track.stop());
      remoteAudioStream = null;
    }

    if (remoteVideoStream) {
      remoteVideoStream.getTracks().forEach((track) => track.stop());
      remoteVideoStream = null;
    }

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    if (bgKeepAliveAudio) {
      bgKeepAliveAudio.pause();
    }
    releaseMediaSession();
    releaseWakeLock();
    if (iceDisconnectTimeout) {
      clearTimeout(iceDisconnectTimeout);
      iceDisconnectTimeout = null;
    }
    if (connectionFailedTimeout) {
      clearTimeout(connectionFailedTimeout);
      connectionFailedTimeout = null;
    }

    if (localVideoPlayer) localVideoPlayer.srcObject = null;
    if (remoteVideoPlayer) remoteVideoPlayer.srcObject = null;
    if (remoteAudioPlayer) remoteAudioPlayer.srcObject = null;
    if (floatingPipVideo) floatingPipVideo.srcObject = null;

    if (callSystemPipBtn) {
      callSystemPipBtn.style.display = 'none';
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }

    if (ongoingCallBanner) {
      ongoingCallBanner.style.display = 'none';
    }
    if (floatingCallPip) {
      floatingCallPip.style.display = 'none';
    }

    if (outgoingCallModal) hideModal(outgoingCallModal);
    if (incomingCallModal) hideModal(incomingCallModal);
    if (activeCallModal) {
      hideModal(activeCallModal);
      activeCallModal.classList.remove('controls-hidden');
    }
    resetPipPosition();
  }

  // ─── WhatsApp Draggable PiP (Picture-in-Picture) Local Video ───────────────
  let pipStartX = 0;
  let pipStartY = 0;
  let pipInitialLeft = 0;
  let pipInitialTop = 0;
  let isDraggingPip = false;
  let pipMovedDistance = 0;

  function initDraggablePip() {
    if (!localVideoWrapper) return;

    localVideoWrapper.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;

      isDraggingPip = true;
      pipMovedDistance = 0;
      pipStartX = e.clientX;
      pipStartY = e.clientY;

      const rect = localVideoWrapper.getBoundingClientRect();
      pipInitialLeft = rect.left;
      pipInitialTop = rect.top;

      try {
        localVideoWrapper.setPointerCapture(e.pointerId);
      } catch (err) {}

      localVideoWrapper.classList.remove('is-snapping');
      localVideoWrapper.classList.add('is-dragging');
    });

    localVideoWrapper.addEventListener('pointermove', (e) => {
      if (!isDraggingPip) return;

      const deltaX = e.clientX - pipStartX;
      const deltaY = e.clientY - pipStartY;
      pipMovedDistance = Math.hypot(deltaX, deltaY);

      let newLeft = pipInitialLeft + deltaX;
      let newTop = pipInitialTop + deltaY;

      // Clamping within window boundaries
      const maxLeft = window.innerWidth - localVideoWrapper.offsetWidth - 10;
      const maxTop = window.innerHeight - localVideoWrapper.offsetHeight - 10;
      newLeft = Math.max(10, Math.min(newLeft, maxLeft));
      newTop = Math.max(10, Math.min(newTop, maxTop));

      localVideoWrapper.style.left = `${newLeft}px`;
      localVideoWrapper.style.top = `${newTop}px`;
      localVideoWrapper.style.right = 'auto';
      localVideoWrapper.style.bottom = 'auto';
    });

    const handlePointerEnd = (e) => {
      if (!isDraggingPip) return;
      isDraggingPip = false;

      try {
        localVideoWrapper.releasePointerCapture(e.pointerId);
      } catch (err) {}

      localVideoWrapper.classList.remove('is-dragging');

      if (pipMovedDistance > 8) {
        snapPipToNearestCorner();
      } else {
        // Tap on the small PiP box -> Swap video views (self <-> partner) exactly like WhatsApp!
        toggleVideoSwap();
      }

      // Reset distance after short delay so screen click handler knows it was a drag
      setTimeout(() => {
        pipMovedDistance = 0;
      }, 160);
    };

    localVideoWrapper.addEventListener('pointerup', handlePointerEnd);
    localVideoWrapper.addEventListener('pointercancel', handlePointerEnd);
  }

  function snapPipToNearestCorner() {
    if (!localVideoWrapper) return;
    localVideoWrapper.classList.add('is-snapping');

    const rect = localVideoWrapper.getBoundingClientRect();
    const pipW = localVideoWrapper.offsetWidth;
    const pipH = localVideoWrapper.offsetHeight;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // Determine nearest horizontal edge (Left vs Right)
    const centerX = rect.left + pipW / 2;
    const snapLeft = centerX < winW / 2 ? 14 : winW - pipW - 14;

    // Clamp vertical position
    let snapTop = rect.top;
    const padTop = 20;
    const padBottom = 95;
    if (snapTop < padTop) {
      snapTop = padTop;
    } else if (snapTop > winH - pipH - padBottom) {
      snapTop = winH - pipH - padBottom;
    }

    localVideoWrapper.style.left = `${snapLeft}px`;
    localVideoWrapper.style.top = `${snapTop}px`;
    localVideoWrapper.style.right = 'auto';
    localVideoWrapper.style.bottom = 'auto';

    setTimeout(() => {
      if (localVideoWrapper) {
        localVideoWrapper.classList.remove('is-snapping');
      }
    }, 340);
  }

  function resetPipPosition() {
    if (!localVideoWrapper) return;
    localVideoWrapper.classList.remove('is-dragging', 'is-snapping');
    localVideoWrapper.style.left = '';
    localVideoWrapper.style.top = '';
    localVideoWrapper.style.right = '';
    localVideoWrapper.style.bottom = '';
  }

  // ─── Floating Draggable Mini PiP for Minimized Video Call (WhatsApp Style) ─
  let floatingPipStartX = 0;
  let floatingPipStartY = 0;
  let floatingPipInitialLeft = 0;
  let floatingPipInitialTop = 0;
  let isDraggingFloatingPip = false;
  let floatingPipMovedDistance = 0;

  function initDraggableFloatingPip() {
    if (!floatingCallPip) return;

    floatingCallPip.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;

      isDraggingFloatingPip = true;
      floatingPipMovedDistance = 0;
      floatingPipStartX = e.clientX;
      floatingPipStartY = e.clientY;

      const rect = floatingCallPip.getBoundingClientRect();
      floatingPipInitialLeft = rect.left;
      floatingPipInitialTop = rect.top;

      try {
        floatingCallPip.setPointerCapture(e.pointerId);
      } catch (err) {}

      floatingCallPip.classList.remove('is-snapping');
      floatingCallPip.classList.add('is-dragging');
    });

    floatingCallPip.addEventListener('pointermove', (e) => {
      if (!isDraggingFloatingPip) return;

      const deltaX = e.clientX - floatingPipStartX;
      const deltaY = e.clientY - floatingPipStartY;
      floatingPipMovedDistance = Math.hypot(deltaX, deltaY);

      let newLeft = floatingPipInitialLeft + deltaX;
      let newTop = floatingPipInitialTop + deltaY;

      const maxLeft = window.innerWidth - floatingCallPip.offsetWidth - 10;
      const maxTop = window.innerHeight - floatingCallPip.offsetHeight - 10;
      newLeft = Math.max(10, Math.min(newLeft, maxLeft));
      newTop = Math.max(10, Math.min(newTop, maxTop));

      floatingCallPip.style.left = `${newLeft}px`;
      floatingCallPip.style.top = `${newTop}px`;
      floatingCallPip.style.right = 'auto';
      floatingCallPip.style.bottom = 'auto';
    });

    const handleFloatingPointerEnd = (e) => {
      if (!isDraggingFloatingPip) return;
      isDraggingFloatingPip = false;

      try {
        floatingCallPip.releasePointerCapture(e.pointerId);
      } catch (err) {}

      floatingCallPip.classList.remove('is-dragging');

      if (floatingPipMovedDistance > 8) {
        snapFloatingPipToNearestCorner();
      } else {
        // Clean tap on floating PiP -> Restore fullscreen call!
        restoreCallFullscreen();
      }

      setTimeout(() => {
        floatingPipMovedDistance = 0;
      }, 160);
    };

    floatingCallPip.addEventListener('pointerup', handleFloatingPointerEnd);
    floatingCallPip.addEventListener('pointercancel', handleFloatingPointerEnd);
  }

  function snapFloatingPipToNearestCorner() {
    if (!floatingCallPip) return;
    floatingCallPip.classList.add('is-snapping');

    const rect = floatingCallPip.getBoundingClientRect();
    const pipW = floatingCallPip.offsetWidth;
    const pipH = floatingCallPip.offsetHeight;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    const centerX = rect.left + pipW / 2;
    const snapLeft = centerX < winW / 2 ? 14 : winW - pipW - 14;

    let snapTop = rect.top;
    const padTop = 60;
    const padBottom = 85;
    if (snapTop < padTop) {
      snapTop = padTop;
    } else if (snapTop > winH - pipH - padBottom) {
      snapTop = winH - pipH - padBottom;
    }

    floatingCallPip.style.left = `${snapLeft}px`;
    floatingCallPip.style.top = `${snapTop}px`;
    floatingCallPip.style.right = 'auto';
    floatingCallPip.style.bottom = 'auto';

    setTimeout(() => {
      if (floatingCallPip) {
        floatingCallPip.classList.remove('is-snapping');
      }
    }, 340);
  }

  function resetFloatingPipPosition() {
    if (!floatingCallPip) return;
    floatingCallPip.classList.remove('is-dragging', 'is-snapping');
    floatingCallPip.style.left = '';
    floatingCallPip.style.top = '';
    floatingCallPip.style.right = '14px';
    floatingCallPip.style.bottom = '90px';
  }

  // ─── WhatsApp Immersion: Tap screen to toggle controls & topbar ───────────
  function initScreenTapControlsToggle() {
    if (!activeCallModal) return;

    activeCallModal.addEventListener('click', (e) => {
      if (callState !== 'connected') return;

      // Ignore if clicking on control buttons or topbar
      if (e.target.closest('.active-call-controls-bar') || e.target.closest('.active-call-topbar')) return;

      // Ignore if clicking or dragging the local video PiP
      if (e.target.closest('#localVideoWrapper') || pipMovedDistance > 8) return;

      // Toggle immersion mode
      activeCallModal.classList.toggle('controls-hidden');
    });
  }

  // ─── Adaptive Bitrate & Network Quality Monitor ─────────────────────────────
  function startStatsMonitor(pc) {
    stopStatsMonitor();
    lastPacketsSent = 0;
    lastPacketsLost = 0;

    statsMonitorInterval = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected' || callState !== 'connected') {
        return;
      }

      try {
        const stats = await pc.getStats();
        let currentPacketsSent = 0;
        let currentPacketsLost = 0;
        let currentRtt = 0;

        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            currentPacketsSent += report.packetsSent || 0;
          }
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            currentPacketsLost += report.packetsLost || 0;
            if (typeof report.roundTripTime === 'number') {
              currentRtt = report.roundTripTime * 1000;
            }
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
            currentRtt = report.currentRoundTripTime * 1000;
          }
        });

        const deltaSent = currentPacketsSent - lastPacketsSent;
        const deltaLost = currentPacketsLost - lastPacketsLost;
        lastPacketsSent = currentPacketsSent;
        lastPacketsLost = currentPacketsLost;

        if (deltaSent > 25) {
          const lossRate = Math.max(0, deltaLost) / (deltaSent + Math.max(0, deltaLost));
          // Native WebRTC Google Congestion Control handles bitrate scaling seamlessly without encoder resets.
          // Only intervene on extreme persistent congestion:
          if (lossRate > 0.20 && currentRtt > 450) {
            tuneSenderParameters(pc, callType, 800000);
          } else if (lossRate <= 0.02 && currentRtt <= 200) {
            tuneSenderParameters(pc, callType, 1800000);
          }
        }
      } catch (e) {}
    }, 3000);
  }

  function stopStatsMonitor() {
    if (statsMonitorInterval) {
      clearInterval(statsMonitorInterval);
      statsMonitorInterval = null;
    }
  }

  // ─── Auto ICE Restart & Dynamic Renegotiation ──────────────────────────────
  async function triggerIceRestart(reason) {
    if (!peerConnection || callState !== 'connected' || isRenegotiating) return;
    isRenegotiating = true;
    console.log('🔄 Triggering WebRTC ICE Restart:', reason);

    try {
      if (typeof peerConnection.restartIce === 'function') {
        peerConnection.restartIce();
      }
      const offer = await peerConnection.createOffer({ iceRestart: true });
      let finalOffer = offer;
      try {
        const optimizedSdp = optimizeSdp(offer.sdp, callType === 'video', false);
        finalOffer = new RTCSessionDescription({ type: offer.type, sdp: optimizedSdp });
        await peerConnection.setLocalDescription(finalOffer);
      } catch (e) {
        finalOffer = offer;
        await peerConnection.setLocalDescription(offer);
      }

      if (window.ChatSocket) {
        window.ChatSocket.emit('call_renegotiate', {
          targetUserId: targetPartnerId || currentCallerId,
          type: 'offer',
          sdp: finalOffer,
        });
      }
    } catch (err) {
      console.warn('ICE restart failed:', err);
    } finally {
      setTimeout(() => {
        isRenegotiating = false;
      }, 4000);
    }
  }

  // ─── Socket Event Listeners ─────────────────────────────────────────────────
  function registerSocketEvents() {
    if (!window.ChatSocket) {
      setTimeout(registerSocketEvents, 300);
      return;
    }

    // 1. Incoming Call
    window.ChatSocket.on('incoming_call', (data) => {
      console.log('📞 Incoming call event:', data);
      handleIncomingCall(data);
    });

    // 2. Outgoing Call Ringing (callee received the offer)
    window.ChatSocket.on('call_ringing', () => {
      console.log('🔔 Call is ringing on remote device');
      if (outgoingCallStatus) outgoingCallStatus.textContent = 'Ringing...';
    });

    // 3. Outgoing Call Accepted
    window.ChatSocket.on('call_accepted', async (data) => {
      console.log('✅ Call accepted by remote user');
      stopAllTones();
      if (!peerConnection || !data?.answer) return;

      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        await tuneSenderParameters(peerConnection, callType);

        // Flush queued candidates
        while (pendingIceCandidates.length > 0) {
          const candidate = pendingIceCandidates.shift();
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch((e) => console.warn(e));
        }

        transitionToConnected();
      } catch (err) {
        console.error('setRemoteDescription on call_accepted failed:', err);
      }
    });

    // 4. Remote Ice Candidate
    window.ChatSocket.on('ice_candidate', async (data) => {
      if (!data?.candidate) return;
      const rtcCandidate = new RTCIceCandidate(data.candidate);

      if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        try {
          await peerConnection.addIceCandidate(rtcCandidate);
        } catch (err) {
          console.warn('addIceCandidate error:', err);
        }
      } else {
        pendingIceCandidates.push(data.candidate);
      }
    });

    // 5. Call Rejected / Busy (Closes instantly on decline)
    window.ChatSocket.on('call_rejected', (data) => {
      const reason = data?.reason === 'busy' ? 'Partner is busy in another call' : 'Call declined';
      stopAllTones();
      playEndTone();
      cleanupCallState();
      if (window.UI?.showToast) {
        window.UI.showToast(reason, 'info');
      }
    });

    // 6. Call Ended by other user
    window.ChatSocket.on('call_ended', (data) => {
      console.log('🔴 Call ended by remote user:', data);
      const customMsg = data?.durationSec > 0 ? `Call ended (${formatDuration(data.durationSec)})` : 'Call ended';
      endCall(false, customMsg);
    });

    // 7. Auto-renegotiate / ICE Restart
    window.ChatSocket.on('call_renegotiate', async (data) => {
      if (!peerConnection || callState !== 'connected' || !data?.sdp) return;
      console.log('🔄 Received call_renegotiate:', data.type);

      try {
        if (data.type === 'offer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

          // Flush any queued candidates
          while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch((e) => console.warn(e));
          }

          const answer = await peerConnection.createAnswer();
          let finalAnswer = answer;
          try {
            const optimizedAnswer = optimizeSdp(answer.sdp, callType === 'video', true);
            finalAnswer = new RTCSessionDescription({ type: answer.type, sdp: optimizedAnswer });
            await peerConnection.setLocalDescription(finalAnswer);
          } catch (e) {
            finalAnswer = answer;
            await peerConnection.setLocalDescription(answer);
          }
          await tuneSenderParameters(peerConnection, callType);

          window.ChatSocket.emit('call_renegotiate', {
            targetUserId: data.senderId,
            type: 'answer',
            sdp: finalAnswer,
          });
        } else if (data.type === 'answer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await tuneSenderParameters(peerConnection, callType);

          while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch((e) => console.warn(e));
          }
        }
      } catch (err) {
        console.warn('Handling call_renegotiate error:', err);
      }
    });
  }

  // ─── UI Event Listeners ─────────────────────────────────────────────────────
  function initCallUI() {
    // Ensure all calling modals and dropdowns are hidden on initial load
    cleanupCallState();
    toggleCallDropdown(false);

    // 1. WhatsApp Phone Header Button -> Toggle Dropdown
    if (callActionBtn) {
      callActionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCallDropdown();
      });
    }

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (callChoiceDropdown && callChoiceDropdown.classList.contains('show')) {
        if (!callChoiceDropdown.contains(e.target) && e.target !== callActionBtn) {
          toggleCallDropdown(false);
        }
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toggleCallDropdown(false);
      }
    });

    // 2. Dropdown Choices
    if (startVoiceCallBtn) {
      startVoiceCallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        initiateCall('audio');
      });
    }

    if (startVideoCallBtn) {
      startVideoCallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        initiateCall('video');
      });
    }

    // 3. Outgoing Call Controls
    if (cancelOutgoingCallBtn) {
      cancelOutgoingCallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelOutgoingCall();
      });
    }

    // 4. Incoming Call Controls
    if (acceptCallBtn) {
      acceptCallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        acceptIncomingCall();
      });
    }

    if (declineCallBtn) {
      declineCallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        declineIncomingCall('declined');
      });
    }

    // 5. Active Call Controls
    if (callToggleSpeakerBtn) {
      callToggleSpeakerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSpeaker();
      });
    }

    if (callToggleMicBtn) {
      callToggleMicBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMicrophone();
      });
    }

    if (callToggleVideoBtn) {
      callToggleVideoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleVideoCamera();
      });
    }

    if (callFlipCameraBtn) {
      callFlipCameraBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        flipCamera();
      });
    }

    if (endActiveCallBtn) {
      endActiveCallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        endCall(true);
      });
    }

    // 6. WhatsApp Minimization & Header Banner Controls
    if (callMinimizeBtn) {
      callMinimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        minimizeCall();
      });
    }

    if (callSystemPipBtn) {
      callSystemPipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSystemPictureInPicture();
      });
    }


    if (ongoingCallBanner) {
      ongoingCallBanner.addEventListener('click', (e) => {
        // If clicking end call button inside banner, let its own handler handle it
        if (e.target.closest('#ongoingBannerEndBtn')) return;
        restoreCallFullscreen();
      });
    }

    if (ongoingBannerEndBtn) {
      ongoingBannerEndBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        endCall(true);
      });
    }

    // WhatsApp Back Navigation: If active call is open and user presses Android/Browser back, minimize instead of closing app
    window.addEventListener('popstate', (e) => {
      if (callState === 'connected' && !isCallMinimized) {
        minimizeCall();
        try {
          window.history.pushState({ inCallBackground: true }, '');
        } catch (err) {}
      }
    });

    // Handle unload / tab close
    window.addEventListener('beforeunload', () => {
      if (callState !== 'idle') {
        endCall(true);
      }
    });

    // Video Playback Watchdog: Auto-resume video if browser pauses it
    if (remoteVideoPlayer) {
      remoteVideoPlayer.addEventListener('pause', () => {
        if (callState === 'connected' && callType === 'video' && remoteVideoPlayer.paused && !isVideoSwapped) {
          remoteVideoPlayer.play().catch(() => {});
        }
      });
      // Handle OS-level Picture-in-Picture events
      remoteVideoPlayer.addEventListener('enterpictureinpicture', () => {
        if (activeCallModal && !isCallMinimized) {
          minimizeCall();
        }
      });
      remoteVideoPlayer.addEventListener('leavepictureinpicture', () => {
        // User closed or expanded out of system PiP
      });
    }

    // Audio Playback Watchdog: Auto-resume audio if browser pauses it
    if (remoteAudioPlayer) {
      remoteAudioPlayer.addEventListener('pause', () => {
        if (callState === 'connected' && remoteAudioPlayer.paused && (callType === 'audio' || isVideoSwapped)) {
          remoteAudioPlayer.play().catch(() => {});
        }
      });
    }

    // Background App Switching (Preserve Mic & Audio when leaving Chrome/switching apps)
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Initialize Draggable PiP & Screen Tap Immersion
    initDraggablePip();
    initDraggableFloatingPip();
    initScreenTapControlsToggle();

    // Initialize socket events
    registerSocketEvents();
  }

  // ─── Background Visibility Change Handler ───────────────────────────────────
  function handleVisibilityChange() {
    if (callState !== 'connected') return;

    if (document.hidden) {
      console.log('📱 App moved to background - preserving mic & background audio');
      if (bgKeepAliveAudio && bgKeepAliveAudio.paused) {
        bgKeepAliveAudio.play().catch(() => {});
      }
      if (remoteAudioPlayer && remoteAudioPlayer.paused && (callType === 'audio' || isVideoSwapped)) {
        remoteAudioPlayer.play().catch(() => {});
      }

      // In video calls: Android suspends camera in background.
      // Temporarily mute local video track to save 100% cellular bandwidth for mic!
      if (callType === 'video' && localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = false;
        }
      }
      // Ensure microphone track remains 100% active
      if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack && !callToggleMicBtn?.classList.contains('btn-muted')) {
          audioTrack.enabled = true;
        }
      }
    } else {
      console.log('📱 App returned to foreground - restoring video display');
      if (callType === 'video' && localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack && !callToggleVideoBtn?.classList.contains('btn-muted')) {
          videoTrack.enabled = true;
        }
        if (localVideoPlayer && localVideoPlayer.paused) {
          localVideoPlayer.play().catch(() => {});
        }
        if (remoteVideoPlayer && remoteVideoPlayer.paused) {
          remoteVideoPlayer.play().catch(() => {});
        }
      }
      if (remoteAudioPlayer && remoteAudioPlayer.paused && (callType === 'audio' || isVideoSwapped)) {
        remoteAudioPlayer.play().catch(() => {});
      }
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCallUI);
  } else {
    initCallUI();
  }

  // Export CallManager on window
  window.CallManager = {
    startVoiceCall: () => initiateCall('audio'),
    startVideoCall: () => initiateCall('video'),
    endCurrentCall: () => endCall(true),
    getState: () => callState,
    isCallActive: () => callState !== 'idle',
  };
})();
