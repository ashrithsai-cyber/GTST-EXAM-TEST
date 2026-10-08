import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicrophoneMonitor, describeMicrophoneError } from '../src/hooks/useMicrophone.js';

function createBrowser({ contextState = 'running', resumeBlocked = false, permissionError, permissionPromise, noAudioTrack = false } = {}) {
  let now = 0;
  let amplitude = 0;
  let state = {};
  let nextFrameId = 0;
  let context;
  const frames = new Map();
  const track = new EventTarget();
  Object.assign(track, { readyState: 'live', enabled: true, muted: false, stops: 0,
    stop() { this.stops += 1; this.readyState = 'ended'; },
  });
  const stream = { getTracks: () => [track], getAudioTracks: () => noAudioTrack ? [] : [track] };
  const source = { disconnected: false, connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; } };
  const analyser = { disconnected: false, fftSize: 0, getByteTimeDomainData(data) {
    for (let index = 0; index < data.length; index += 1) data[index] = 128 + (index % 2 ? amplitude : -amplitude);
  }, disconnect() { this.disconnected = true; } };
  class AudioContext extends EventTarget {
    constructor() { super(); this.state = contextState; this.resumeBlocked = resumeBlocked; context = this; }
    createMediaStreamSource() { return source; }
    createAnalyser() { return analyser; }
    resume() {
      if (this.resumeBlocked) return new Promise(() => {});
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const browser = {
    isSecureContext: true,
    navigator: { mediaDevices: { async getUserMedia(constraints) {
      assert.deepEqual(constraints, { audio: true });
      if (permissionError) throw Object.assign(new Error(permissionError), { name: permissionError });
      return permissionPromise || stream;
    } } },
    AudioContext,
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextFrameId, callback); return nextFrameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const monitor = createMicrophoneMonitor((update) => { state = { ...state, ...update }; }, browser);
  return {
    browser, monitor, track, stream, source, analyser,
    get state() { return state; },
    get context() { return context; },
    get frameCount() { return frames.size; },
    sound(value) { amplitude = value; },
    advance(ms) { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now)); },
  };
}

test('permission alone and silence never pass the microphone input test', async () => {
  const env = createBrowser();
  await env.monitor.start();
  assert.equal(env.state.ready, true);
  assert.equal(env.state.inputDetected, false);
  env.advance(3000);
  assert.equal(env.state.inputDetected, false);
  assert.equal(env.state.level, 0);
  assert.equal(env.state.muted, true);
  env.monitor.stop();
});

test('sustained audio moves the meter and retains a passed test during ordinary silence', async () => {
  const env = createBrowser();
  await env.monitor.start();
  env.sound(16);
  env.advance(80);
  assert.ok(env.state.level > 0);
  assert.equal(env.state.inputDetected, false);
  env.advance(80);
  env.advance(80);
  env.advance(80);
  assert.equal(env.state.inputDetected, true);
  env.sound(0);
  env.advance(3000);
  assert.equal(env.state.ready, true);
  assert.equal(env.state.muted, true);
  assert.equal(env.state.inputDetected, true);
  assert.equal(env.state.error, '');
  assert.deepEqual(env.source.connections, [env.analyser]);
  env.monitor.stop();
});

test('a brief audio click cannot pass the input test', async () => {
  const env = createBrowser();
  await env.monitor.start();
  env.sound(16);
  env.advance(80);
  env.sound(0);
  env.advance(80);
  env.advance(1000);
  assert.equal(env.state.inputDetected, false);
  env.monitor.stop();
});

test('suspended Web Audio offers gesture activation and does not hang setup', async () => {
  const env = createBrowser({ contextState: 'suspended', resumeBlocked: true });
  await env.monitor.start();
  assert.equal(env.state.loading, false);
  assert.equal(env.state.ready, false);
  assert.equal(env.state.needsActivation, true);
  assert.equal(env.state.inputDetected, false);
  env.context.resumeBlocked = false;
  await env.monitor.resume();
  assert.equal(env.state.ready, true);
  assert.equal(env.state.needsActivation, false);
  env.monitor.stop();
});

test('device mute invalidates audio proof and unmute requires a fresh sound test', async () => {
  const env = createBrowser();
  await env.monitor.start();
  env.sound(16);
  for (let index = 0; index < 4; index += 1) env.advance(80);
  assert.equal(env.state.inputDetected, true);
  env.track.muted = true;
  env.track.dispatchEvent(new Event('mute'));
  assert.equal(env.state.ready, false);
  assert.equal(env.state.inputDetected, false);
  env.track.muted = false;
  env.track.dispatchEvent(new Event('unmute'));
  assert.equal(env.state.ready, true);
  assert.equal(env.state.inputDetected, false);
  env.monitor.stop();
});

test('device disconnect reports failure and releases all audio resources', async () => {
  const env = createBrowser();
  await env.monitor.start();
  env.track.readyState = 'ended';
  env.track.dispatchEvent(new Event('ended'));
  assert.equal(env.state.ready, false);
  assert.equal(env.state.inputDetected, false);
  assert.match(env.state.error, /disconnected/);
  assert.equal(env.frameCount, 0);
  assert.equal(env.source.disconnected, true);
  assert.equal(env.analyser.disconnected, true);
  assert.equal(env.context.state, 'closed');
});

test('permission, missing-device and busy-device failures have distinct actionable messages', async () => {
  for (const [name, expected] of [['NotAllowedError', /blocked/], ['NotFoundError', /No microphone/], ['NotReadableError', /other applications/]]) {
    const env = createBrowser({ permissionError: name });
    await env.monitor.start();
    assert.equal(env.state.loading, false);
    assert.equal(env.state.ready, false);
    assert.match(env.state.error, expected);
  }
  assert.match(describeMicrophoneError({ name: 'SecurityError' }), /HTTPS/);
});

test('a granted stream without a live audio track fails safely', async () => {
  const env = createBrowser({ noAudioTrack: true });
  await env.monitor.start();
  assert.equal(env.state.ready, false);
  assert.match(env.state.error, /no live audio/);
  assert.equal(env.track.stops, 1);
});

test('unmount while permission is pending stops the late stream without updating state', async () => {
  let resolvePermission;
  const permissionPromise = new Promise((resolve) => { resolvePermission = resolve; });
  const env = createBrowser({ permissionPromise });
  const opening = env.monitor.start();
  const stateBeforeStop = env.state;
  env.monitor.stop();
  resolvePermission(env.stream);
  await opening;
  assert.deepEqual(env.state, stateBeforeStop);
  assert.equal(env.track.stops, 1);
  assert.equal(env.frameCount, 0);
  assert.equal(env.context, undefined);
});

test('unsupported media access describes insecure context without claiming permission was denied', async () => {
  const env = createBrowser();
  env.browser.navigator.mediaDevices = undefined;
  env.browser.isSecureContext = false;
  await env.monitor.start();
  assert.match(env.state.error, /secure connection/);
  assert.equal(env.state.loading, false);
});
