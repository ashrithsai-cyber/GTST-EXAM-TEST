import { useState, useEffect, useRef, useCallback } from 'react';
import { createCameraHealth } from '../utils/cameraHealth';

const VIDEO_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 480 } };
// How long to wait, after permission is granted, for the <video> (rendered
// by LiveCameraPreview) to start producing frames before reporting failure.
const FIRST_FRAME_TIMEOUT_MS = 10000;
const FRAME_POLL_MS = 100;

// Maps the browser's DOMException name to a message the student can act on.
function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access is blocked. Please allow camera permission in your browser (camera icon in the address bar) and in your system privacy settings, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device. Please connect a camera and try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera is being used by another application (for example Zoom, Teams or another browser tab). Close it and try again.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Your camera does not support the required video settings. Please try a different camera.';
    case 'SecurityError':
      return 'Camera access is not allowed on this page. Please open the exam over HTTPS and try again.';
    case 'AbortError':
      return 'The camera could not be started. Please try again.';
    default:
      return 'The camera could not be started. Please check your camera and try again.';
  }
}

// enabled defaults to true. SystemCheckContext passes enabled: false
// outside the exam flow and when an admin has turned off the camera
// requirement, so the permission prompt only fires when actually needed
// and the camera is released as soon as it no longer is.
export function useCamera({ enabled = true } = {}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [stream, setStream] = useState(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return undefined;
    }

    let cancelled = false;
    let pollTimer = null;
    let healthTimer = null;
    let removeHealthListeners = () => {};
    const wait = (ms) => new Promise((resolve) => { pollTimer = setTimeout(resolve, ms); });

    const requestStream = async () => {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      } catch (err) {
        if (err?.name !== 'OverconstrainedError') throw err;
        return navigator.mediaDevices.getUserMedia({ video: true });
      }
    };

    // Ready means the <video> is actually rendering frames from this
    // stream — not merely that permission was granted.
    const waitForFirstFrame = async (mediaStream) => {
      const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
      while (!cancelled && Date.now() < deadline) {
        const video = videoRef.current;
        if (video) {
          if (video.srcObject !== mediaStream) video.srcObject = mediaStream;
          if (video.paused) video.play().catch(() => {});
          if (
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.videoWidth > 0 &&
            video.videoHeight > 0
          ) {
            return true;
          }
        }
        await wait(FRAME_POLL_MS);
      }
      return false;
    };

    const start = async () => {
      setError('');
      setReady(false);

      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        setError(window.isSecureContext
          ? 'This browser does not support camera access. Please use the latest Chrome, Edge or Firefox.'
          : 'Camera access requires a secure connection. Please open the exam over HTTPS (or on localhost).');
        return;
      }

      let mediaStream;
      try {
        mediaStream = await requestStream();
      } catch (err) {
        if (!cancelled) setError(describeCameraError(err));
        return;
      }
      if (cancelled) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }

      const liveTrack = mediaStream.getVideoTracks().find((track) => track.readyState === 'live' && track.enabled);
      if (!liveTrack) {
        mediaStream.getTracks().forEach((track) => track.stop());
        setError('The camera started but is not sending video. Please check your camera and try again.');
        return;
      }

      // Fires when the device goes away (unplugged, permission revoked,
      // taken by the OS) — never for our own track.stop() in cleanup.
      // Dropping `ready` is what lets the exam page report the loss and
      // show the Retry Camera button.
      liveTrack.addEventListener('ended', () => {
        if (cancelled) return;
        setReady(false);
        setError('Your camera was disconnected. Reconnect it and click Retry Camera.');
      });

      streamRef.current = mediaStream;
      setStream(mediaStream);

      const checkHealth = createCameraHealth();
      const monitor = () => {
        if (cancelled) return;
        const state = checkHealth({ track: liveTrack, video: videoRef.current, hidden: document.hidden, now: performance.now() });
        if (state) { setReady(state.ready); setError(state.error); }
      };
      liveTrack.addEventListener('mute', monitor);
      liveTrack.addEventListener('unmute', monitor);
      removeHealthListeners = () => {
        liveTrack.removeEventListener('mute', monitor);
        liveTrack.removeEventListener('unmute', monitor);
      };
      healthTimer = setInterval(monitor, 500);

      const gotFrame = await waitForFirstFrame(mediaStream);
      if (cancelled) return;
      if (gotFrame) {
        setReady(true);
      } else {
        setError('The camera was allowed but no video is coming through. Close other apps using the camera and try again.');
      }
    };

    start();

    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      clearInterval(healthTimer);
      removeHealthListeners();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      setStream(null);
    };
  }, [attempt, enabled]);

  const retry = () => setAttempt((a) => a + 1);
  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setStream(null);
    setReady(false);
  }, []);

  // Still starting whenever the camera is wanted but has neither come up
  // nor failed — so there's never a moment where it reads as "Blocked"
  // without a reason.
  const loading = enabled && !ready && !error;

  return { videoRef, stream, ready, loading, error, retry, stop };
}
