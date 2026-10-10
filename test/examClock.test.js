import test from 'node:test';
import assert from 'node:assert/strict';
import { createCountdown, readCountdown } from '../src/utils/examClock.js';

test('countdown consumes actual monotonic elapsed time after a suspended tab', () => {
  const anchor = createCountdown(120, 1000);
  assert.equal(readCountdown(anchor, 61000), 60);
  assert.equal(readCountdown(anchor, 181000), 0);
});

test('a server synchronization corrects display drift without using the device clock', () => {
  const first = createCountdown(90, 0);
  assert.equal(readCountdown(first, 10000), 80);
  const synchronized = createCountdown(73, 10000);
  assert.equal(readCountdown(synchronized, 12000), 71);
});

test('unscheduled countdown is absent and elapsed exams never become negative', () => {
  assert.equal(readCountdown(createCountdown(null, 0), 10000), null);
  assert.equal(readCountdown(createCountdown(-1, 0), 10000), 0);
});
