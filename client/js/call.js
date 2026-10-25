'use strict';

/**
 * call.js — WhatsApp-Style Real-time WebRTC Audio & Video Calling Engine
 * 100% Peer-to-Peer (0 MB Render server bandwidth consumption)
 * Uses pure Web Audio API for telephone ringtones (zero audio asset dependencies)
 */

(function () {
  // ─── Configuration ──────────────────────────────────────────────────────────
  // ─── Configuration ──────────────────────────────────────────────────────────
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.services.mozilla.com' },
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle', // Multiplex all tracks onto single UDP transport
    rtcpMuxPolicy: 'require',
  };

  // ─── WebRTC SDP Optimization for Full HD & Slow Networks ───────────────────
  function optimizeSdp(sdp, isVideo) {
    if (!sdp) return sdp;
    let modified = sdp;

    // 1. Audio optimization: Enable Opus In-Band Forward Error Correction (FEC)
    // Guarantees zero robot/choppy voice even on slow 3G/4G lossy networks
    if (modified.includes('opus/48000')) {
      modified = modified.replace(/(a=rtpmap:(\d+) opus\/48000\/2[\s\S]*?a=fmtp:\2[^\r\n]*)/gi, (match) => {
        if (match.includes('useinbandfec=1')) return match;
        return `${match};useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000`;
      });
      if (!modified.includes('useinbandfec=1')) {
        modified = modified.replace(/a=rtpmap:(\d+) opus\/48000\/2/gi, '$&\r\na=fmtp:$1 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000');
      }
    }

    // 2. Video optimization: Guaranteed HD Bitrate & Fast Ramp-up
    if (isVideo) {
      // Dynamic Bitrate: Minimum 600 kbps, Starts immediately in HD (2000 kbps), Peak 4000 kbps
      modified = modified.replace(/(a=fmtp:\d+ [^\r\n]+)/gi, (match) => {
        if (match.includes('x-google-') || match.includes('apt=')) return match;
        return `${match};x-google-min-bitrate=600;x-google-start-bitrate=2000;x-google-max-bitrate=4000`;
      });

      // Add 3.5 Mbps bandwidth ceiling in m=video line
      modified = modified.replace(/(m=video [^\r\n]+\r\n)/gi, '$1b=AS:3500\r\nb=TIAS:3500000\r\n');
    }

    return modified;
  }

  // ─── RTCRtpSender Hardware & Bitrate Tuning ─────────────────────────────────
  async function tuneSenderParameters(pc, type) {
    if (!pc || !pc.getSenders) return;
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (!sender.track) continue;

        if (sender.track.kind === 'video' && type === 'video') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 3500000; // 3.5 Mbps Full HD
            params.encodings[0].minBitrate = 600000;  // 600 kbps minimum
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            // 'balanced': Preserves Full HD crispness smoothly on slow networks
            params.degradationPreference = 'balanced';
            await sender.setParameters(params);
          } catch (e) {
            console.warn('Sender video parameter tuning error:', e.message);
          }
        } else if (sender.track.kind === 'audio') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 64000; // 64 kbps HD Voice
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            await sender.setParameters(params);
          } catch (e) {
            console.warn('Sender audio parameter tuning error:', e.message);
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
  let callTimerInterval = null;
  let callSecondsElapsed = 0;
  let pendingIceCandidates = [];
  let incomingCallTimeout = null;

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
  const activeCallPartnerAvatar = document.getElementById('activeCallPartnerAvatar');
  const activeCallPartnerName = document.getElementById('activeCallPartnerName');
  const callDurationTimer = document.getElementById('callDurationTimer');

  // Active call controls
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
    if (callDurationTimer) callDurationTimer.textContent = '00:00';
    callTimerInterval = setInterval(() => {
      callSecondsElapsed++;
      if (callDurationTimer) {
        callDurationTimer.textContent = formatDuration(callSecondsElapsed);
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
      const svg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100%" height="100%" fill="%238b5cf6"/><text x="50%" y="54%" font-size="44" font-family="Arial,sans-serif" font-weight="bold" fill="%23ffffff" dominant-baseline="middle" text-anchor="middle">${initial}</text></svg>`;
      imgEl.src = svg;
    }
  }

  // ─── Local Media Acquisition (Full HD 1080p / 720p with Dynamic Fallback) ──
  async function acquireLocalStream(type) {
    const audioConstraints = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 },
    };

    const fullHdVideoConstraints = {
      facingMode: currentFacingMode,
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      frameRate: { ideal: 30, max: 30 },
      aspectRatio: { ideal: 16 / 9 },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: type === 'video' ? fullHdVideoConstraints : false,
      });
      localStream = stream;

      // Bind to local video player if video call
      if (type === 'video' && localVideoPlayer) {
        localVideoPlayer.srcObject = stream;
        localVideoPlayer.muted = true;
        if (currentFacingMode === 'user') {
          localVideoPlayer.classList.add('mirror');
        } else {
          localVideoPlayer.classList.remove('mirror');
        }
        localVideoPlayer.play().catch(() => {});
      }
      return stream;
    } catch (err) {
      // If 1080p sensor constraint threw OverconstrainedError, gracefully fallback to 720p HD
      if (type === 'video' && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
        console.warn('1080p Full HD not supported by device camera, falling back to 720p HD...');
        try {
          const fallbackConstraints = {
            facingMode: currentFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          };
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: fallbackConstraints,
          });
          localStream = stream;
          if (localVideoPlayer) {
            localVideoPlayer.srcObject = stream;
            localVideoPlayer.muted = true;
            if (currentFacingMode === 'user') {
              localVideoPlayer.classList.add('mirror');
            } else {
              localVideoPlayer.classList.remove('mirror');
            }
            localVideoPlayer.play().catch(() => {});
          }
          return stream;
        } catch (fallbackErr) {
          console.error('Fallback getUserMedia failed:', fallbackErr);
          throw fallbackErr;
        }
      }

      console.error('Failed to acquire media stream:', err);
      if (window.UI?.showToast) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          window.UI.showToast('Microphone / Camera permission denied.', 'error');
        } else {
          window.UI.showToast('Could not access microphone or camera.', 'error');
        }
      }
      throw err;
    }
  }

  // ─── WebRTC Peer Connection Setup ───────────────────────────────────────────
  function createPeerConnection(targetId) {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnection = pc;
    pendingIceCandidates = [];

    // Attach local stream tracks to PC
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    // ICE Candidate handler -> send via socket
    pc.onicecandidate = (event) => {
      if (event.candidate && window.ChatSocket) {
        window.ChatSocket.emit('ice_candidate', {
          targetUserId: targetId || targetPartnerId || currentCallerId,
          candidate: event.candidate,
        });
      }
    };

    // Remote Track handler
    pc.ontrack = (event) => {
      console.log('📡 Remote track received:', event.track.kind);
      if (!remoteStream) {
        remoteStream = new MediaStream();
      }
      remoteStream.addTrack(event.track);

      if (event.track.kind === 'video' && remoteVideoPlayer) {
        remoteVideoPlayer.srcObject = remoteStream;
        remoteVideoPlayer.play().catch(() => {});
      } else if (event.track.kind === 'audio' && remoteAudioPlayer) {
        remoteAudioPlayer.srcObject = remoteStream;
        remoteAudioPlayer.play().catch(() => {});
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      console.log('🔄 WebRTC connectionState:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        tuneSenderParameters(pc, callType);
        transitionToConnected();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (callState === 'connected') {
          endCall(false, 'Connection lost');
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('📶 ICE Connection State:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        tuneSenderParameters(pc, callType);
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
      const optimizedSdp = optimizeSdp(offer.sdp, type === 'video');
      const finalOffer = new RTCSessionDescription({ type: offer.type, sdp: optimizedSdp });
      await pc.setLocalDescription(finalOffer);
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

    // If currently already busy in a call, reject
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
    if (callState !== 'ringing' || !incomingOfferData) return;
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

      const answer = await pc.createAnswer();
      const optimizedAnswerSdp = optimizeSdp(answer.sdp, callType === 'video');
      const finalAnswer = new RTCSessionDescription({ type: answer.type, sdp: optimizedAnswerSdp });
      await pc.setLocalDescription(finalAnswer);
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
      declineIncomingCall('error');
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

    // Setup active call UI based on type
    const partner = getPartnerInfo();
    applyAvatarToImg(activeCallPartnerAvatar, partner.profileImage, partner.displayName);
    if (activeCallPartnerName) activeCallPartnerName.textContent = partner.displayName;

    if (callType === 'video') {
      if (callVideoContainer) callVideoContainer.style.display = 'block';
      if (callAudioContainer) callAudioContainer.style.display = 'none';
      if (callFlipCameraBtn) callFlipCameraBtn.style.display = 'inline-flex';
      if (callToggleVideoBtn) callToggleVideoBtn.style.display = 'inline-flex';
    } else {
      if (callVideoContainer) callVideoContainer.style.display = 'none';
      if (callAudioContainer) callAudioContainer.style.display = 'flex';
      if (callFlipCameraBtn) callFlipCameraBtn.style.display = 'none';
      if (callToggleVideoBtn) callToggleVideoBtn.style.display = 'none';
    }

    // Reset controls state
    resetControlsUI();
    startDurationTimer();
  }

  function resetControlsUI() {
    if (callToggleMicBtn) callToggleMicBtn.classList.remove('btn-muted');
    if (callMicOnIcon) callMicOnIcon.style.display = 'block';
    if (callMicOffIcon) callMicOffIcon.style.display = 'none';

    if (callToggleVideoBtn) callToggleVideoBtn.classList.remove('btn-muted');
    if (callVideoOnIcon) callVideoOnIcon.style.display = 'block';
    if (callVideoOffIcon) callVideoOffIcon.style.display = 'none';
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

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: currentFacingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

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

      if (localVideoPlayer) {
        localVideoPlayer.srcObject = localStream;
        if (currentFacingMode === 'user') {
          localVideoPlayer.classList.add('mirror');
        } else {
          localVideoPlayer.classList.remove('mirror');
        }
      }
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

    stopDurationTimer();
    stopAllTones();

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

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    if (localVideoPlayer) localVideoPlayer.srcObject = null;
    if (remoteVideoPlayer) remoteVideoPlayer.srcObject = null;
    if (remoteAudioPlayer) remoteAudioPlayer.srcObject = null;

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

  // ─── WhatsApp Immersion: Tap screen to toggle controls & topbar ───────────
  function initScreenTapControlsToggle() {
    if (!activeCallModal) return;

    activeCallModal.addEventListener('click', (e) => {
      if (callState !== 'connected') return;

      // Ignore if clicking on control buttons
      if (e.target.closest('.active-call-controls-bar')) return;

      // Ignore if clicking or dragging the local video PiP
      if (e.target.closest('#localVideoWrapper') || pipMovedDistance > 8) return;

      // Toggle immersion mode
      activeCallModal.classList.toggle('controls-hidden');
    });
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

    // 5. Call Rejected / Busy
    window.ChatSocket.on('call_rejected', (data) => {
      const reason = data?.reason === 'busy' ? 'Partner is busy in another call' : 'Call declined';
      stopAllTones();
      playEndTone();
      if (outgoingCallStatus) outgoingCallStatus.textContent = reason;
      setTimeout(() => {
        cleanupCallState();
        if (window.UI?.showToast) {
          window.UI.showToast(reason, 'info');
        }
      }, 1500);
    });

    // 6. Call Ended by other user
    window.ChatSocket.on('call_ended', (data) => {
      console.log('🔴 Call ended by remote user:', data);
      const customMsg = data?.durationSec > 0 ? `Call ended (${formatDuration(data.durationSec)})` : 'Call ended';
      endCall(false, customMsg);
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

    // Handle unload / tab close
    window.addEventListener('beforeunload', () => {
      if (callState !== 'idle') {
        endCall(true);
      }
    });

    // Initialize Draggable PiP & Screen Tap Immersion
    initDraggablePip();
    initScreenTapControlsToggle();

    // Initialize socket events
    registerSocketEvents();
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
  };
})();
