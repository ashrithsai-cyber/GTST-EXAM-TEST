import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraHealth } from '../src/utils/cameraHealth.js';

test('camera health tolerates brief mute, warns for persistent mute, and recovers', () => {
  const health = createCameraHealth();
  const track = { readyState: 'live', enabled: true, muted: false };
  const video = { currentTime: 1, readyState: 2, videoWidth: 640 };
  const tick = now => health({ track, video, now });
  assert.equal(tick(0).ready, true);
  track.muted = true;
  assert.equal(tick(500), null); assert.equal(tick(1500), null);
  assert.equal(tick(4000).ready, false);
  track.muted = false; video.currentTime = 2;
  assert.equal(tick(4500).ready, true);
  track.readyState = 'ended'; assert.match(tick(5000).error, /disconnected/);
});
test('camera health detects a stalled feed without flagging a suspended hidden tab', () => {
  const health = createCameraHealth();
  const track = { readyState: 'live', enabled: true };
  const video = { currentTime: 1, readyState: 2, videoWidth: 640 };
  assert.equal(health({ track, video, now: 0 }).ready, true);
  assert.equal(health({ track, video, now: 9000, hidden: true }), null);
  assert.equal(health({ track, video, now: 10000 }).ready, true);
  assert.equal(health({ track, video, now: 19000 }).ready, false);
});
