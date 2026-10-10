import { useState, useEffect, useRef, useCallback } from 'react';
import { countFaces, createFaceStabilizer } from '../utils/faceTracker.js';

// Face-detection assets are tried from our own origin first — the WASM
// runtime is copied out of the pinned @mediapipe/tasks-vision package into
// public/mediapipe/wasm by scripts/copy-mediapipe-assets.mjs (runs before
// dev/build), and the model lives at public/mediapipe/ — so an exam never
// depends on a third-party CDN being reachable. The public CDN is only a
// fallback for a deployment that is missing the local copies.
const BASE = import.meta.env.BASE_URL || '/';
const ASSET_SOURCES = [
  {
    wasm: `${BASE}mediapipe/wasm`,
    model: `${BASE}mediapipe/blaze_face_short_range.tflite`,
  },
  {
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
  },
];

// A hung download must surface as a clear error, not an endless
// "Loading face detection…".
const LOAD_TIMEOUT_MS = 20000;
const DETECT_INTERVAL_MS = 300;
// Mean frame brightness (0-255). Below LOW_LIGHT the frame is brightened
// before detection; LOW_LIGHT also makes "no face" wait longer.
const LOW_LIGHT_LUMA = 70;
const TARGET_LUMA = 115;
const MAX_BRIGHTNESS_GAIN = 3;

// Average brightness of a tiny copy of the frame — cheap enough per tick.
function measureLuma(video, probe) {
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, probe.width, probe.height);
  const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / (data.length / 4);
}

// Brightened copy of a dim frame for the detector. Returns null where the
// browser has no canvas filters, so the plain frame is used instead.
function brightenedFrame(video, canvas, luma) {
  if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
  if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  const gain = Math.min(MAX_BRIGHTNESS_GAIN, TARGET_LUMA / Math.max(luma, 1));
  ctx.filter = `brightness(${gain.toFixed(2)}) contrast(1.15)`;
  if (ctx.filter === 'none') return null;
  ctx.drawImage(video, 0, 0);
  ctx.filter = 'none';
  return canvas;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Face detection load timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function createDetector() {
  // Loaded on first use so the login page doesn't download it.
  const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
  let lastError;
  for (const source of ASSET_SOURCES) {
    try {
      return await withTimeout((async () => {
        const vision = await FilesetResolver.forVisionTasks(source.wasm);
        return FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: source.model, delegate: 'CPU' },
          runningMode: 'VIDEO',
          // Permissive here so a face in poor light is still found;
          // utils/faceTracker.js applies the stricter per-face rules.
          minDetectionConfidence: 0.5,
        });
      })(), LOAD_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Face detection unavailable');
}

// faceCount / faceState are the *stable* reading (see utils/faceTracker.js):
// faceState is 'checking' | 'single' | 'none' | 'multiple'. lowLight tells
// the student their picture is too dark for reliable detection.
export function useFaceDetection(videoRef, active) {
  const [faceCount, setFaceCount] = useState(0);
  const [faceState, setFaceState] = useState('checking');
  const [lowLight, setLowLight] = useState(false);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const detectorRef = useRef(null);
  const rafRef = useRef(null);
  const lastDetectTimeRef = useRef(0);

  // Lets the student retry a failed load (e.g. a network blip) without
  // refreshing the page and losing their progress through System Check.
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;
    const stabilizer = createFaceStabilizer();
    const probe = Object.assign(document.createElement('canvas'), { width: 32, height: 24 });
    const enhanced = document.createElement('canvas');
    let lastVideoTime = -1;

    const sample = (video, detector, now) => {
      // A frame that hasn't changed (camera stalled) or isn't decodable
      // yet says nothing about the student — don't count it as "no face".
      if (video.readyState < 2 || !video.videoWidth || video.currentTime === lastVideoTime) return { count: null };
      lastVideoTime = video.currentTime;
      let luma = TARGET_LUMA;
      try {
        luma = measureLuma(video, probe);
      } catch {
        // Brightness unknown: detect on the plain frame.
      }
      const dim = luma < LOW_LIGHT_LUMA;
      const frame = (dim && brightenedFrame(video, enhanced, luma)) || video;
      try {
        const result = detector.detectForVideo(frame, now);
        return { count: countFaces(result.detections, video.videoWidth), lowLight: dim };
      } catch {
        // The detector can transiently reject a timestamp; skip the frame.
        return { count: null, lowLight: dim };
      }
    };

    const loop = (now) => {
      const video = videoRef.current;
      const detector = detectorRef.current;

      if (video && detector && now - lastDetectTimeRef.current >= DETECT_INTERVAL_MS) {
        lastDetectTimeRef.current = now;
        const { count, lowLight: dim } = sample(video, detector, now);
        const stable = stabilizer.push(now, count, { lowLight: Boolean(dim) });
        setFaceState(stable.state);
        setFaceCount(stable.count);
        if (dim !== undefined) setLowLight(dim);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    const init = async () => {
      setModelLoading(true);
      setModelError('');
      try {
        const detector = await createDetector();
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;
        setModelLoading(false);
        rafRef.current = requestAnimationFrame(loop);
      } catch {
        if (!cancelled) {
          setModelError('Unable to load face detection. Please check your internet connection and select Retry.');
          setModelLoading(false);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (detectorRef.current) {
        detectorRef.current.close();
        detectorRef.current = null;
      }
      setFaceCount(0);
      setFaceState('checking');
      setLowLight(false);
    };
  }, [active, videoRef, attempt]);

  return { faceCount, faceState, lowLight, modelLoading, modelError, retry };
}
