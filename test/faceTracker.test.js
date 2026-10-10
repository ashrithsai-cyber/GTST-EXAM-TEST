import test from 'node:test';
import assert from 'node:assert/strict';
import { countFaces, createFaceStabilizer, FACE_STALE_MS } from '../src/utils/faceTracker.js';

const FRAME_W = 640;
const det = (x, y, w, h, score = 0.9) => ({ boundingBox: { originX: x, originY: y, width: w, height: h }, categories: [{ score }] });
const student = det(240, 120, 160, 180, 0.95);
const helper = det(30, 100, 110, 130, 0.85);

test('countFaces: one real face, duplicates merged, ghosts and tiny boxes ignored', () => {
  assert.equal(countFaces([], FRAME_W), 0);
  assert.equal(countFaces([student], FRAME_W), 1);
  // Two overlapping boxes on the same face.
  assert.equal(countFaces([student, det(250, 130, 150, 170, 0.8)], FRAME_W), 1);
  // A weak detection in a shadow is not a second person.
  assert.equal(countFaces([student, det(480, 60, 90, 100, 0.6)], FRAME_W), 1);
  // A tiny face-like pattern (e.g. on a poster far away).
  assert.equal(countFaces([student, det(20, 20, 18, 20, 0.95)], FRAME_W), 1);
  // Below the base confidence nothing counts.
  assert.equal(countFaces([det(240, 120, 160, 180, 0.4)], FRAME_W), 0);
});

test('countFaces: a clearly visible second person is counted', () => {
  assert.equal(countFaces([student, helper], FRAME_W), 2);
  assert.equal(countFaces([student, helper, det(470, 90, 120, 140, 0.9)], FRAME_W), 3);
  // Same-size faces are both counted (neither is dropped as "the main face").
  assert.equal(countFaces([det(40, 100, 150, 170), det(420, 100, 150, 170)], FRAME_W), 2);
});

// Feeds one reading every 300 ms (the detector interval).
function feed(stabilizer, clock, ms, count, options) {
  let result;
  for (let t = 0; t < ms; t += 300) {
    clock.now += 300;
    result = stabilizer.push(clock.now, typeof count === 'function' ? count(clock.now) : count, options);
  }
  return result;
}

test('a single stray frame with two faces does not trigger "multiple"', () => {
  const s = createFaceStabilizer();
  const clock = { now: 0 };
  assert.equal(feed(s, clock, 3000, 1).state, 'single');
  let i = 0;
  const flicker = () => (i++ % 7 === 3 ? 2 : 1); // one frame in seven
  for (let t = 0; t < 6000; t += 300) assert.equal(feed(s, clock, 300, flicker).state, 'single');
});

test('two faces consistently for ~2 s become "multiple" with the right count', () => {
  const s = createFaceStabilizer();
  const clock = { now: 0 };
  feed(s, clock, 3000, 1);
  assert.equal(feed(s, clock, 900, 2).state, 'single', 'not yet consistent');
  const result = feed(s, clock, 1500, 2);
  assert.equal(result.state, 'multiple');
  assert.equal(result.count, 2);
  // Recovers once the second person leaves.
  assert.equal(feed(s, clock, 1500, 1).state, 'single');
});

test('blinks, head turns and motion blur (short dropouts) keep "single"', () => {
  const s = createFaceStabilizer();
  const clock = { now: 0 };
  feed(s, clock, 3000, 1);
  let i = 0;
  const dropouts = () => (i++ % 4 === 0 ? 0 : 1); // a lost frame every ~1.2 s
  for (let t = 0; t < 10000; t += 300) assert.equal(feed(s, clock, 300, dropouts).state, 'single');
  // Even a full second lost in a row is not "no face".
  assert.equal(feed(s, clock, 900, 0).state, 'single');
});

test('leaving the frame becomes "none" after ~1.5 s; in low light it waits ~3 s', () => {
  const s = createFaceStabilizer();
  const clock = { now: 0 };
  feed(s, clock, 3000, 1);
  assert.equal(feed(s, clock, 1200, 0).state, 'single', 'not yet');
  assert.equal(feed(s, clock, 600, 0).state, 'none', 'by 1.8 s');

  const dim = createFaceStabilizer();
  const dimClock = { now: 0 };
  feed(dim, dimClock, 3000, 1, { lowLight: true });
  assert.equal(feed(dim, dimClock, 2100, 0, { lowLight: true }).state, 'single', 'low light: not yet');
  assert.equal(feed(dim, dimClock, 1200, 0, { lowLight: true }).state, 'none', 'low light: by 3.3 s');
});

test('frozen or unusable camera frames never count as "no face"', () => {
  const s = createFaceStabilizer();
  const clock = { now: 0 };
  feed(s, clock, 3000, 1);
  // Unusable frames are skipped; the last state holds briefly…
  assert.equal(feed(s, clock, 1500, null).state, 'single');
  // …then becomes "checking" (unknown), not "none".
  assert.equal(feed(s, clock, FACE_STALE_MS, null).state, 'checking');
  // Frames return: back to a real reading.
  assert.equal(feed(s, clock, 1200, 1).state, 'single');
});

test('starts in "checking" until enough frames have been seen', () => {
  const s = createFaceStabilizer();
  const clock = { now: 0 };
  assert.equal(feed(s, clock, 300, 1).state, 'checking');
  assert.equal(feed(s, clock, 900, 1).state, 'single');
});

// Real detector ticks are uneven (rAF + ~300 ms gate, CPU load). A window
// check that assumed exact 300 ms spacing once left the state stuck.
function feedJittered(stabilizer, clock, ms, count, seed = 1) {
  let result;
  let x = seed;
  const end = clock.now + ms;
  while (clock.now < end) {
    x = (x * 16807) % 2147483647;
    clock.now += 300 + (x % 90); // 300-389 ms
    result = stabilizer.push(clock.now, count);
  }
  return result;
}

test('uneven tick spacing: settles on one face, flags two, and recovers', () => {
  for (const seed of [1, 7, 42, 99, 1234]) {
    const s = createFaceStabilizer();
    const clock = { now: 5000 };
    assert.equal(feedJittered(s, clock, 1600, 1, seed).state, 'single', `seed ${seed}: single within 1.6 s`);
    assert.equal(feedJittered(s, clock, 3000, 2, seed).state, 'multiple', `seed ${seed}: multiple`);
    assert.equal(feedJittered(s, clock, 2600, 1, seed).state, 'single', `seed ${seed}: recovers after the second person leaves`);
    assert.equal(feedJittered(s, clock, 3000, 0, seed).state, 'none', `seed ${seed}: none`);
    assert.equal(feedJittered(s, clock, 1600, 1, seed).state, 'single', `seed ${seed}: back to single`);
  }
});
