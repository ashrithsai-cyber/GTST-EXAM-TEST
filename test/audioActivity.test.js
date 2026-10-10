import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioActivityAnalyzer, speechBandShare, MIC } from '../src/utils/audioActivity.js';

const SAMPLE_RATE = 48000;
const FFT = 2048;
const TICK = 80;
const dbToRms = (db) => 10 ** (db / 20);

// A time-domain frame with the given RMS level.
const frame = (db) => {
  const a = db === null ? 0 : dbToRms(db);
  return Float32Array.from({ length: FFT }, (_, i) => (i % 2 ? a : -a));
};
// Analyser-style dB spectrum: 'speech' concentrates energy in 300-3400 Hz,
// 'broadband' is flat (fan / hiss / traffic).
const spectrum = (kind, db) => Float32Array.from({ length: FFT / 2 }, (_, i) => {
  if (db === null) return -Infinity;
  const hz = (i * SAMPLE_RATE) / FFT;
  return kind === 'speech' && (hz < 300 || hz > 3400) ? db - 25 : db;
});

function run(analyzer, clock, ms, signal) {
  let reading;
  for (let t = 0; t < ms; t += TICK) {
    clock.now += TICK;
    const { db, kind } = signal(clock.now);
    reading = analyzer.update(clock.now, frame(db), spectrum(kind, db), SAMPLE_RATE);
  }
  return reading;
}
const ROOM = { db: -80, kind: 'broadband' };
// Syllables: 200 ms of voice, 150 ms pause.
const voice = (db, between = ROOM) => (now) => (now % 350 < 200 ? { db, kind: 'speech' } : between);

test('speech-band share separates a voice spectrum from flat noise', () => {
  assert.ok(speechBandShare(spectrum('speech', -40), SAMPLE_RATE) > 0.9);
  assert.ok(speechBandShare(spectrum('broadband', -40), SAMPLE_RATE) < MIC.SPEECH_BAND_SHARE);
  assert.equal(speechBandShare(spectrum('speech', null), SAMPLE_RATE), null);
});

test('quiet speech (-55 dBFS) in a quiet room is detected as speech and passes the input test', () => {
  // The old check needed RMS >= 0.01 (-40 dBFS) and read 8-bit samples,
  // where -55 dBFS (RMS 0.0018) rounds to zero — this voice used to fail.
  assert.ok(dbToRms(-55) < 0.01 && dbToRms(-55) < 1 / 128);
  const analyzer = createAudioActivityAnalyzer();
  const clock = { now: 0 };
  assert.equal(run(analyzer, clock, 2000, () => ROOM).activity, 'silence');
  const reading = run(analyzer, clock, 1000, voice(-55));
  assert.equal(reading.activity, 'speech');
  assert.equal(reading.inputConfirmed, true);
  // A soft voice still moves the meter clearly.
  let peak = 0;
  for (let i = 0; i < 6; i += 1) peak = Math.max(peak, run(analyzer, clock, TICK, voice(-55)).level);
  assert.ok(peak >= 50, `meter ${peak}`);
});

test('room tone alone is silence: no meter, no proof, not a failure', () => {
  const analyzer = createAudioActivityAnalyzer();
  const clock = { now: 0 };
  run(analyzer, clock, 1500, () => ROOM);
  const reading = run(analyzer, clock, 8000, () => ROOM);
  assert.equal(reading.activity, 'silence');
  assert.equal(reading.inputConfirmed, false);
  assert.equal(reading.level, 0);
});

test('steady background noise is classified as noise, never speech, and the floor adapts to it', () => {
  const analyzer = createAudioActivityAnalyzer();
  const clock = { now: 0 };
  const fan = () => ({ db: -50, kind: 'broadband' });
  const seen = new Set();
  let reading;
  for (let t = 0; t < 20000; t += TICK) {
    reading = run(analyzer, clock, TICK, fan);
    if (t > 1500) seen.add(reading.activity);
  }
  assert.ok(!seen.has('speech'), [...seen].join(','));
  assert.equal(reading.activity, 'noise');
  assert.ok(reading.floorDb > -53, `floor ${reading.floorDb}`);
});

test('speech is still detected over learned background noise', () => {
  const analyzer = createAudioActivityAnalyzer();
  const clock = { now: 0 };
  const fan = { db: -55, kind: 'broadband' };
  run(analyzer, clock, 20000, () => fan);
  assert.equal(run(analyzer, clock, 1000, voice(-44, fan)).activity, 'speech');
});

test('exact digital zeros become "no-signal" after 3 s; brief zeros do not', () => {
  const analyzer = createAudioActivityAnalyzer();
  const clock = { now: 0 };
  run(analyzer, clock, 1000, () => ROOM);
  assert.notEqual(run(analyzer, clock, 2000, () => ({ db: null })).activity, 'no-signal');
  const reading = run(analyzer, clock, 1500, () => ({ db: null }));
  assert.equal(reading.activity, 'no-signal');
  assert.ok(reading.noSignalMs >= MIC.NO_SIGNAL_MS);
  // Any real signal clears it immediately.
  assert.notEqual(run(analyzer, clock, TICK, () => ROOM).activity, 'no-signal');
});

test('a single click cannot confirm microphone input', () => {
  const analyzer = createAudioActivityAnalyzer();
  const clock = { now: 0 };
  run(analyzer, clock, 1000, () => ROOM);
  run(analyzer, clock, TICK, () => ({ db: -20, kind: 'broadband' }));
  assert.equal(run(analyzer, clock, 1000, () => ROOM).inputConfirmed, false);
});
