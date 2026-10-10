import { useState, useEffect, useRef, useCallback } from 'react';
<<<<<<< HEAD
import { createAudioActivityAnalyzer } from '../utils/audioActivity.js';

const MUTE_GRACE_MS = 2500;
const UPDATE_INTERVAL_MS = 80;
// The browser's own voice processing: noise suppression filters steady
// background noise and automatic gain lifts quiet speech. Plain values are
// preferences, so a device that can't do one still opens.
export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};
=======

const MUTE_GRACE_MS = 2500;
const UPDATE_INTERVAL_MS = 80;
const INPUT_CONFIRM_MS = 240;
const MIN_AUDIBLE_RMS = 0.01;
>>>>>>> origin/main

const INITIAL_STATE = {
  ready: false,
  level: 0,
  muted: false,
  loading: false,
  error: '',
  inputDetected: false,
  needsActivation: false,
<<<<<<< HEAD
  // 'silence' | 'speech' | 'noise' | 'no-signal' — see utils/audioActivity.js
  activity: 'silence',
=======
>>>>>>> origin/main
};

export function describeMicrophoneError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access is blocked. Allow microphone permission in your browser and system privacy settings, then retry.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect a microphone and retry.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone could not be opened. Close other applications using it and check your system microphone settings, then retry.';
    case 'SecurityError':
      return 'Microphone access requires a secure page. Open the exam over HTTPS (or on localhost).';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'The microphone does not support the requested audio settings. Try another microphone.';
    case 'AbortError':
      return 'The browser could not start the microphone. Please retry.';
    default:
      return 'The microphone could not be tested. Check your device and browser audio settings, then retry.';
  }
}

// Keep media lifecycle separate from React so cancellation, device loss and
// browsers that suspend Web Audio can be exercised without a real microphone.
export function createMicrophoneMonitor(onUpdate, browser = globalThis) {
  let stopped = false;
  let stream = null;
  let track = null;
  let audioContext = null;
  let source = null;
  let analyser = null;
  let frame = null;
<<<<<<< HEAD
  let samples = null;
  let bytes = null;
  let spectrum = null;
  let analyzer = createAudioActivityAnalyzer();
  let lastUpdate = 0;
  let lastAudible = 0;
=======
  let data = null;
  let lastUpdate = 0;
  let lastAudible = 0;
  let audibleSince = null;
>>>>>>> origin/main
  let inputDetected = false;
  const listeners = [];

  const emit = (update) => { if (!stopped) onUpdate(update); };
  const listen = (target, event, callback) => {
    target.addEventListener(event, callback);
    listeners.push(() => target.removeEventListener(event, callback));
  };
  const stop = () => {
    stopped = true;
    if (frame !== null) browser.cancelAnimationFrame(frame);
    frame = null;
    listeners.forEach((remove) => remove());
    listeners.length = 0;
    source?.disconnect();
    analyser?.disconnect();
    stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
  };
  const fail = (message) => {
    emit({ ready: false, loading: false, level: 0, inputDetected: false, needsActivation: false, error: message });
    stop();
  };

  const syncAvailability = () => {
    if (stopped) return;
    if (audioContext.state === 'closed') {
      fail('Audio measurement stopped. Please click Retry Microphone Access.');
      return;
    }
    const running = audioContext.state === 'running';
    const live = track.readyState === 'live' && track.enabled && !track.muted;
    if (!running || !live) {
<<<<<<< HEAD
      // Earlier sound must not count as proof after the device comes back.
      inputDetected = false;
      analyzer = createAudioActivityAnalyzer();
=======
      inputDetected = false;
      audibleSince = null;
>>>>>>> origin/main
    }
    emit({
      ready: running && live,
      needsActivation: !running && audioContext.state !== 'closed',
      inputDetected,
<<<<<<< HEAD
      ...(!running || !live ? { level: 0, activity: 'silence' } : {}),
=======
      ...(!running || !live ? { level: 0 } : {}),
>>>>>>> origin/main
    });
  };

  // Called directly by the student's click when autoplay policy requires a
  // gesture. Do not wait for resume during initial permission setup: some
  // browsers leave that promise pending until the next user interaction.
  const resume = async () => {
    if (stopped || !audioContext) return;
    try {
      await audioContext.resume();
      syncAvailability();
    } catch {
      if (!stopped) emit({ ready: false, needsActivation: true, error: 'Audio testing could not start. Click Start Microphone Test, or retry microphone access.' });
    }
  };

  const tick = (now) => {
    if (stopped) return;
    if (track.readyState !== 'live') {
      fail('Your microphone was disconnected. Reconnect it and click Retry Microphone Access.');
      return;
    }
    if (now - lastUpdate >= UPDATE_INTERVAL_MS) {
      lastUpdate = now;
      if (audioContext.state === 'running' && track.enabled && !track.muted) {
<<<<<<< HEAD
        let hasSpectrum = false;
        try {
          // Float samples keep quiet speech that 8-bit samples round to zero.
          if (typeof analyser.getFloatTimeDomainData === 'function') {
            analyser.getFloatTimeDomainData(samples);
          } else {
            analyser.getByteTimeDomainData(bytes);
            for (let i = 0; i < bytes.length; i += 1) samples[i] = (bytes[i] - 128) / 128;
          }
          if (typeof analyser.getFloatFrequencyData === 'function') {
            analyser.getFloatFrequencyData(spectrum);
            hasSpectrum = true;
          }
=======
        try {
          analyser.getByteTimeDomainData(data);
>>>>>>> origin/main
        } catch {
          fail('The browser could not read microphone audio. Please click Retry Microphone Access.');
          return;
        }
<<<<<<< HEAD
        const reading = analyzer.update(now, samples, hasSpectrum ? spectrum : null, audioContext.sampleRate);
        if (reading.active) lastAudible = now;
        if (reading.inputConfirmed) inputDetected = true;
        emit({
          ready: true, level: reading.level, activity: reading.activity, inputDetected,
          muted: now - lastAudible >= MUTE_GRACE_MS, needsActivation: false, error: '',
        });
=======
        let sumSquares = 0;
        for (const sample of data) {
          const amplitude = (sample - 128) / 128;
          sumSquares += amplitude * amplitude;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const level = rms > 0 ? Math.max(0, Math.min(100, Math.round((20 * Math.log10(rms) + 60) / 60 * 100))) : 0;
        if (rms >= MIN_AUDIBLE_RMS) {
          lastAudible = now;
          if (audibleSince === null) audibleSince = now;
          if (now - audibleSince >= INPUT_CONFIRM_MS) inputDetected = true;
        } else {
          audibleSince = null;
        }
        emit({ ready: true, level, inputDetected, muted: now - lastAudible >= MUTE_GRACE_MS, needsActivation: false, error: '' });
>>>>>>> origin/main
      } else {
        syncAvailability();
      }
    }
    frame = browser.requestAnimationFrame(tick);
  };

  const start = async () => {
    emit({ ...INITIAL_STATE, loading: true });
    if (typeof browser.navigator?.mediaDevices?.getUserMedia !== 'function') {
      fail(browser.isSecureContext
        ? 'This browser does not support microphone access. Use a current version of Chrome, Edge or Firefox.'
        : 'Microphone access requires a secure connection. Open the exam over HTTPS (or on localhost).');
      return;
    }
    const AudioContextClass = browser.AudioContext || browser.webkitAudioContext;
    if (!AudioContextClass) {
      fail('This browser cannot measure microphone audio. Please use a browser that supports Web Audio.');
      return;
    }
    try {
<<<<<<< HEAD
      stream = await browser.navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
=======
      stream = await browser.navigator.mediaDevices.getUserMedia({ audio: true });
>>>>>>> origin/main
      if (stopped) {
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        return;
      }
      track = stream.getAudioTracks().find((mediaTrack) => mediaTrack.readyState === 'live' && mediaTrack.enabled);
      if (!track) {
        fail('The microphone was allowed but no live audio input is available. Check your microphone and retry.');
        return;
      }
      audioContext = new AudioContextClass();
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
<<<<<<< HEAD
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser); // Never connect the microphone to speakers.
      samples = new Float32Array(analyser.fftSize);
      bytes = new Uint8Array(analyser.fftSize);
      spectrum = new Float32Array(analyser.fftSize / 2);
=======
      analyser.fftSize = 1024;
      source.connect(analyser); // Never connect the microphone to speakers.
      data = new Uint8Array(analyser.fftSize);
>>>>>>> origin/main
      lastAudible = browser.performance.now();
      listen(track, 'ended', () => fail('Your microphone was disconnected. Reconnect it and click Retry Microphone Access.'));
      listen(track, 'mute', syncAvailability);
      listen(track, 'unmute', syncAvailability);
      listen(audioContext, 'statechange', syncAvailability);
      syncAvailability();
      emit({ loading: false });
      frame = browser.requestAnimationFrame(tick);
      if (audioContext.state !== 'running') void resume();
    } catch (error) {
      if (!stopped) fail(describeMicrophoneError(error));
    }
  };

  return { start, stop, resume };
}

// ready proves a live device and running analyser. inputDetected proves a
// sustained sound sample for System Check. Acoustic silence (`muted`) after
// that proof is normal during the exam and must never be a device violation.
export function useMicrophone({ enabled = true } = {}) {
  const [state, setState] = useState(INITIAL_STATE);
  const [attempt, setAttempt] = useState(0);
  const monitorRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL_STATE);
      return undefined;
    }
    const monitor = createMicrophoneMonitor((update) => setState((current) => ({ ...current, ...update })));
    monitorRef.current = monitor;
    void monitor.start();
    return () => {
      monitor.stop();
      if (monitorRef.current === monitor) monitorRef.current = null;
    };
  }, [attempt, enabled]);

  const retry = useCallback(() => {
    setState({ ...INITIAL_STATE, loading: enabled });
    setAttempt((current) => current + 1);
  }, [enabled]);
  const resume = useCallback(() => monitorRef.current?.resume(), []);

  return { ...state, retry, resume };
}
