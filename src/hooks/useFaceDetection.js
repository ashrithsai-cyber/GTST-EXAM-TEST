import { useState, useEffect, useRef, useCallback } from 'react';

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
          minDetectionConfidence: 0.65,
        });
      })(), LOAD_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Face detection unavailable');
}

export function useFaceDetection(videoRef, active) {
  const [faceCount, setFaceCount] = useState(0);
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

    const loop = (now) => {
      const video = videoRef.current;
      const detector = detectorRef.current;

      if (video && detector && video.readyState >= 2 && now - lastDetectTimeRef.current >= DETECT_INTERVAL_MS) {
        lastDetectTimeRef.current = now;
        try {
          const result = detector.detectForVideo(video, now);
          setFaceCount(result.detections.length);
        } catch {
          // Skip this frame; the detector can transiently reject a timestamp.
        }
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
    };
  }, [active, videoRef, attempt]);

  return { faceCount, modelLoading, modelError, retry };
}
