// Turns raw per-frame face detections into a stable proctoring state.
// A single frame is never trusted on its own: lighting changes, motion
// blur and camera hiccups make detectors flicker, so the state only
// changes once a reading has been consistent for a while.

// Per-frame filtering (MediaPipe detections -> number of real faces).
export const FACE_MIN_SCORE = 0.5;
// An additional face must be detected confidently and be a plausible size,
// so a ghost detection in a shadow or a tiny face-like pattern in the
// background does not count as a second person.
export const EXTRA_FACE_MIN_SCORE = 0.7;
export const EXTRA_FACE_MIN_AREA_RATIO = 0.08; // vs. the main face
export const FACE_MIN_WIDTH_RATIO = 0.04; // vs. the frame width
const DUPLICATE_IOU = 0.3;

function boxOf(detection) {
  const b = detection?.boundingBox;
  if (!b || !(b.width > 0) || !(b.height > 0)) return null;
  return { x: b.originX ?? 0, y: b.originY ?? 0, w: b.width, h: b.height };
}

function scoreOf(detection) {
  return detection?.categories?.[0]?.score ?? 0;
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function centreInside(inner, outer) {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

export function countFaces(detections, frameWidth) {
  const faces = (detections || [])
    .map((d) => ({ box: boxOf(d), score: scoreOf(d) }))
    .filter((f) => f.box && f.score >= FACE_MIN_SCORE && (!frameWidth || f.box.w >= frameWidth * FACE_MIN_WIDTH_RATIO))
    .sort((a, b) => b.score - a.score);

  // One person can produce overlapping/nested boxes — keep one.
  const kept = [];
  for (const face of faces) {
    if (!kept.some((k) => iou(face.box, k.box) > DUPLICATE_IOU || centreInside(face.box, k.box) || centreInside(k.box, face.box))) {
      kept.push(face);
    }
  }
  if (kept.length <= 1) return kept.length;

  const area = (f) => f.box.w * f.box.h;
  const main = kept.reduce((best, f) => (area(f) > area(best) ? f : best));
  const extras = kept.filter((f) => f !== main
    && f.score >= EXTRA_FACE_MIN_SCORE
    && area(f) >= area(main) * EXTRA_FACE_MIN_AREA_RATIO);
  return 1 + extras.length;
}

// How long (ms) and how consistently (share of frames) a reading must hold
// before the stable state switches to it.
export const FACE_CONFIRM = {
  single: { ms: 900, share: 0.7 },
  multiple: { ms: 2000, share: 0.6 },
  none: { ms: 1500, share: 0.8 },
  // A dim room makes faces harder to find; wait longer before "no face".
  noneLowLight: { ms: 3000, share: 0.8 },
};
// No usable frame for this long (camera stalled) -> back to "checking"
// rather than reporting "no face" for a frozen picture.
export const FACE_STALE_MS = 3000;
const HISTORY_MS = 6000;
const MIN_WINDOW_READINGS = 3;

const rawState = (count) => (count === 0 ? 'none' : count === 1 ? 'single' : 'multiple');

export function createFaceStabilizer() {
  let samples = []; // { t, count, lowLight }
  let state = 'checking';
  let stableCount = 0;

  const share = (now, ms, predicate) => {
    // Only judge a window once readings have been arriving for that long,
    // and from more than a frame or two. (Detector ticks are not evenly
    // spaced, so the oldest reading *inside* the window can be up to one
    // tick younger than the window itself.)
    if (!samples.length || now - samples[0].t < ms) return 0;
    const recent = samples.filter((s) => now - s.t <= ms);
    if (recent.length < MIN_WINDOW_READINGS) return 0;
    return recent.filter(predicate).length / recent.length;
  };

  const modeOfMultiple = (now) => {
    const counts = {};
    for (const s of samples) if (now - s.t <= FACE_CONFIRM.multiple.ms && s.count >= 2) counts[s.count] = (counts[s.count] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    return best ? Number(best[0]) : 2;
  };

  return {
    // count: faces in this frame, or null when the frame was unusable
    // (camera not delivering frames, detector rejected the frame).
    push(now, count, { lowLight = false } = {}) {
      if (count !== null && count !== undefined) samples.push({ t: now, count, lowLight });
      samples = samples.filter((s) => now - s.t <= HISTORY_MS);
      const last = samples[samples.length - 1];
      if (!last || now - last.t > FACE_STALE_MS) {
        state = 'checking';
        stableCount = 0;
        return { state, count: stableCount };
      }

      const dim = share(now, FACE_CONFIRM.none.ms, (s) => s.lowLight) >= 0.5;
      const noneRule = dim ? FACE_CONFIRM.noneLowLight : FACE_CONFIRM.none;
      const candidates = [
        ['multiple', FACE_CONFIRM.multiple],
        ['none', noneRule],
        ['single', FACE_CONFIRM.single],
      ];
      for (const [name, rule] of candidates) {
        if (share(now, rule.ms, (s) => rawState(s.count) === name) >= rule.share) {
          state = name;
          break;
        }
      }
      // Otherwise the reading is mixed: keep the previous stable state.
      stableCount = state === 'multiple' ? modeOfMultiple(now) : state === 'single' ? 1 : 0;
      return { state, count: stableCount };
    },
    reset() {
      samples = [];
      state = 'checking';
      stableCount = 0;
    },
  };
}
