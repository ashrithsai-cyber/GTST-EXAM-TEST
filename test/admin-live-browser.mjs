// Built admin dashboard regression against a local fixture; never accesses Supabase.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin-frontend');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
await access(chromePath); await access(path.join(root, 'dist', 'index.html'));
const requests = []; let mode = 'failure';
const session = { id: '00000000-0000-4000-8000-000000000001', candidate_id: 'student-1', status: 'IN_PROGRESS', proctoring_warning_count: 4,
  last_activity_at: new Date().toISOString(), exam_candidates: { full_name: 'Monitoring Fixture Student', registration_id: 'REG-FIXTURE', hall_ticket_number: 'HT-FIXTURE' },
  exams: { exam_name: 'Fixture Exam' }, attempt_progress: null, is_likely_disconnected: false };
const warning = 'Monitoring summaries are unavailable. Review and apply pending migration 021_admin_monitoring_summary.sql to the exam database, then refresh this page.';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: request.method, path: url.pathname });
      let data = {}; let status = 200;
      if (url.pathname === '/api/admin/auth/me') data = { admin: { id: 'fixture-admin', full_name: 'Fixture Admin', name: 'Fixture Admin', email: 'fixture@example.invalid', role: 'super_admin' } };
      else if (url.pathname === '/api/admin/dashboard') data = { dashboard: {} };
      else if (url.pathname === '/api/admin/exams') data = { exams: [] };
      else if (url.pathname === '/api/admin/candidates') data = { candidates: [], total: 0, limit: 100 };
      else if (url.pathname === '/api/admin/sessions') {
        if (mode === 'failure') { status = 500; data = { message: 'Unable to fetch sessions' }; }
        else data = { sessions: [session], total: 1, limit: 100, monitoringWarning: mode === 'missing' ? warning : null };
      }
      else if (url.pathname === '/api/admin/proctoring/event-summaries') {
        if (mode === 'missing') { status = 503; data = { message: warning, code: 'MONITORING_MIGRATION_REQUIRED' }; }
        else data = { summaries: [{ session_id: session.id, event_counts: { CAMERA_DISABLED: 4 }, violation_count: 4 }] };
      }
      else if (url.pathname === '/api/admin/proctoring/events') data = { events: [], total: 0, limit: 100 };
      else { status = 404; data = { message: 'Unknown fixture endpoint' }; }
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const candidate = path.resolve(root, 'dist', relative);
    if (!candidate.startsWith(path.join(root, 'dist') + path.sep) && candidate !== path.join(root, 'dist')) { response.writeHead(403); response.end(); return; }
    const file = path.extname(candidate) ? candidate : path.join(root, 'dist', 'index.html');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
    const data = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(data);
  } catch { response.writeHead(500); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), 'gtst-browser-flow-'));
let chrome; let socket; const exceptions = []; const dialogs = []; let stderr = '';
try {
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const debugUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chromium did not expose a debugging endpoint')), 15000);
    chrome.on('error', reject); chrome.on('exit', (code) => reject(new Error(`Chromium exited ${code}`)));
    chrome.stderr.on('data', (chunk) => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  socket = new WebSocket(debugUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId; const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { const operation = pending.get(message.id); if (!operation) return; clearTimeout(operation.timeout); pending.delete(message.id); if (message.error) operation.reject(new Error(message.error.message)); else operation.resolve(message.result); }
    else if (message.method === 'Page.javascriptDialogOpening') {
      // The exam's beforeunload guard is accepted like a user confirming
      // the reload, and recorded so the test proves it is still active.
      dialogs.push(message.params.type);
      void send('Page.handleJavaScriptDialog', { accept: message.params.type === 'beforeunload' }, message.sessionId).catch(() => {});
    }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    else if (message.method === 'Fetch.requestPaused') {
      const method = message.params.request.url.startsWith(origin) || message.params.request.url.startsWith('data:') ? 'Fetch.continueRequest' : 'Fetch.failRequest';
      void send(method, { requestId: message.params.requestId, ...(method === 'Fetch.failRequest' ? { errorReason: 'Aborted' } : {}) }, message.sessionId).catch(() => {});
    }
  });
  async function page(name, isolated = false) {
    const context = isolated ? await send('Target.createBrowserContext') : null;
    const target = await send('Target.createTarget', { url: 'about:blank', ...(context ? { browserContextId: context.browserContextId } : {}) });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__smokeCase = ${JSON.stringify(name)};
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname.startsWith('/api/')) {
          if (window.__smokeOffline) return Promise.reject(new TypeError('Failed to fetch'));
          if (window.__smokeDropNextDraft && url.pathname === '/api/exam/answers/draft') { window.__smokeDropNextDraft = false; return Promise.reject(new TypeError('Failed to fetch')); }
          if (window.__smokeDropDrafts && url.pathname === '/api/exam/answers/draft') return Promise.reject(new TypeError('Failed to fetch'));
          if (window.__smokeDropEvents && url.pathname === '/api/exam/proctoring/event') return Promise.reject(new TypeError('Failed to fetch'));
          return realFetch(location.origin + url.pathname + url.search, { ...init, headers: { ...init.headers, 'X-Smoke-Case': window.__smokeCase } });
        }
        return realFetch(input, init);
      };
    ` }, sessionId);
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (expression, label, timeoutMs = 10000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 80)); }
      throw new Error(`Timed out waiting for ${label}. Page: ${await evaluate('document.body.innerText')}`);
    };
    const click = async (text) => {
      await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes(${JSON.stringify(text)}) && !button.disabled)`, `enabled ${text}`);
      await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes(${JSON.stringify(text)}) && !button.disabled).click()`);
    };
    return { sessionId, evaluate, wait, click };
  }
  const admin = await page('admin');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.setItem("adminToken", "isolated-fixture-token"); localStorage.setItem("gtst_admin_v2_sidebar_collapsed", "false")' }, admin.sessionId);
  await send('Page.navigate', { url: origin }, admin.sessionId);
  await admin.wait('Array.from(document.querySelectorAll("button")).some(b => b.textContent.includes("Live Students"))', 'admin navigation');
  await admin.click('Live Students');
  await admin.wait('document.querySelector("[role=alert]")?.textContent.includes("Unable to fetch sessions")', 'visible load error');
  assert.equal(await admin.evaluate('document.body.innerText.includes("Loading live students")'), false, 'failed initial request must stop loading');
  assert.equal(await admin.evaluate('document.body.innerText.includes("No students found")'), false, 'failed request must not look like an empty student list');
  mode = 'missing';
  await admin.click('Retry Live Students');
  await admin.wait('document.body.innerText.includes("REG-FIXTURE")', 'student rows despite missing migration');
  await admin.wait('document.querySelector("[role=status]")?.textContent.includes("021_admin_monitoring_summary.sql")', 'migration warning');
  assert.equal(await admin.evaluate('document.querySelector("tbody tr")?.textContent.includes("4")'), true, 'saved warning totals remain available');
  console.log('PASS: initial API failure stops loading and shows Retry; missing migration still displays student rows and saved warning totals.');
  mode = 'failure';
  await admin.wait('document.querySelector("[role=alert]")?.textContent.includes("Showing the last successfully loaded data")', 'poll failure retains stale data', 15000);
  assert.equal(await admin.evaluate('document.body.innerText.includes("REG-FIXTURE")'), true, 'failed poll must keep the last good rows');
  mode = 'success'; session.attempt_progress = { attempted: 2, total: 3, current_subject: 'Mathematics' };
  await admin.click('Retry Live Students');
  await admin.wait('document.body.innerText.includes("2/3") && !document.querySelector("[role=alert]") && !document.querySelector("[role=status]")', 'healthy retry and summaries');
  assert.deepEqual(exceptions, [], 'no browser JavaScript exceptions');
  console.log('PASS: failed poll retains the last good data with a stale warning; retry restores live progress and clears warnings.');

} catch (error) {
  console.error(error.stack); console.error('Recent fixture requests:', JSON.stringify(requests.slice(-12))); process.exitCode = 1;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise((resolve) => { chrome.once('exit', resolve); setTimeout(resolve, 3000); }); }
  await new Promise((resolve) => server.close(resolve));
  const resolvedProfile = path.resolve(profile);
  if (path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('gtst-browser-flow-')) await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
