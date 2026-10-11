import test from 'node:test';
import assert from 'node:assert/strict';
import { apiGet, apiGetBlob, REQUEST_TIMEOUT_MS } from '../admin-frontend/src/services/apiClient.js';

function browserMocks(t) {
  const items = new Map([['adminToken', 'fixture-token']]);
  t.mock.method(globalThis, 'fetch');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => items.get(key), removeItem: key => items.delete(key) } });
  const events = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: event => events.push(event.type) } });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  });
  return { items, events };
}

test('admin API preserves backend error codes for migration recovery', async t => {
  browserMocks(t);
  globalThis.fetch.mock.mockImplementation(async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return new Response(JSON.stringify({ message: 'Apply migration 021', code: 'MONITORING_MIGRATION_REQUIRED' }), { status: 503 });
  });
  await assert.rejects(apiGet('/api/admin/sessions'), error => error.status === 503 && error.data.code === 'MONITORING_MIGRATION_REQUIRED');
});

test('admin API rejects an HTML page returned instead of API JSON', async t => {
  browserMocks(t);
  globalThis.fetch.mock.mockImplementation(async () => new Response('<html>Wrong API host</html>'));
  await assert.rejects(apiGet('/api/admin/sessions'), /backend API URL/);
});

test('admin API 401 clears the token and expires the admin session', async t => {
  const { items, events } = browserMocks(t);
  globalThis.fetch.mock.mockImplementation(async () => new Response('{}', { status: 401 }));
  await assert.rejects(apiGet('/api/admin/sessions'), error => error.status === 401);
  assert.equal(items.has('adminToken'), false);
  assert.deepEqual(events, ['admin-session-expired']);
});

for (const phase of ['headers', 'body', 'blob']) {
  test(`admin request timeout covers stalled ${phase} and releases its timer`, async t => {
    browserMocks(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const waitForAbort = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    globalThis.fetch.mock.mockImplementation(async (_url, { signal }) => {
      if (phase === 'headers') return waitForAbort(signal);
      return { status: 200, ok: true, json: () => waitForAbort(signal), blob: () => waitForAbort(signal) };
    });
    const operation = phase === 'blob' ? apiGetBlob('/api/admin/image') : apiGet('/api/admin/sessions');
    await Promise.resolve();
    const rejected = assert.rejects(operation, error => error.status === 0 && /too long/.test(error.message));
    t.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await rejected;
  });
}
