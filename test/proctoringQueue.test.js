import test from 'node:test';
import assert from 'node:assert/strict';
import { createProctoringQueue } from '../src/utils/proctoringQueue.js';

test('offline violations persist, restore after refresh, and reuse the same event ID on retry', async () => {
  const data = new Map(); const storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) };
  let offline = true; const received = [];
  const send = async event => { received.push(event); if (offline) throw new Error('offline'); return { success: true }; };
  const first = createProctoringQueue({ key: 'attempt', storage, send, uuid: () => 'event-1', now: () => '2026-10-10T12:00:00.000Z' });
  await assert.rejects(first.enqueue('CAMERA_DISABLED', 'Camera unplugged').flush);
  assert.equal(first.pending(), 1);
  const restored = createProctoringQueue({ key: 'attempt', storage, send }); offline = false;
  await restored.flush();
  assert.equal(restored.pending(), 0);
  assert.deepEqual(received[0], received[1]);
});
test('concurrent flushing preserves every queued event and stops at a failed acknowledgement', async () => {
  let id = 0; const sent = [];
  const queue = createProctoringQueue({ key: 'attempt', storage: null, uuid: () => String(++id), send: async event => { await Promise.resolve(); sent.push(event.clientEventId); return { success: true }; } });
  await Promise.all([queue.enqueue('TAB_SWITCH', '').flush, queue.enqueue('FULLSCREEN_EXIT', '').flush]);
  assert.deepEqual(sent, ['1', '2']); assert.equal(queue.pending(), 0);
});
