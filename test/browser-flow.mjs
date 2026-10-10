// Runs the built student frontend against an isolated in-memory API fixture.
// No production database, credentials, or remote server is used. Real Chromium
// Web Audio measures a generated MediaStream; hardware checks need a separate
// manual run on supported student devices.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
await access(chromePath);
await access(path.join(root, 'dist', 'index.html'));
const requests = [];
const cases = new Map();
const questions = [303, 101, 202].map((id, index) => ({
  id, questionNumber: index + 1, questionText: `Fixture question ${id}: choose an answer.`,
  options: { A: 'First option', B: 'Second option', C: 'Third option', D: 'Fourth option' }, marks: 1,
}));
const subject = { subjectId: 9, subjectKey: 'MATHEMATICS', subjectName: 'Mathematics', questionCount: questions.length, displayOrder: 1, durationSeconds: 180 };
const settings = { cameraRequired: false, photoCaptureEnabled: false, microphoneRequired: true,
  fullscreenRequired: false, proctoringEnabled: false, faceDetectionEnabled: false, videoRequired: false,
  networkMonitoringEnabled: true, tabSwitchMonitoringEnabled: false };
// 'devices' requires camera, check-in photo and fullscreen through Chrome's
// fake capture device; 'offline' uses a short question timer.
function settingsFor(state) {
  return state.name === 'devices' ? { ...settings, cameraRequired: true, photoCaptureEnabled: true, fullscreenRequired: true } : settings;
}
const questionSeconds = (state) => (state.name === 'offline' ? 4 : 60);
const exam = { id: 99, examName: 'GTST Browser Test', totalQuestions: 3, secondsPerQuestion: 60, totalDurationSeconds: 180, totalMarks: 3 };
function fixture(name) {
  if (!cases.has(name)) cases.set(name, { name, position: 0, answers: new Map(), locked: new Set(), logins: 0, startedAt: null, questionStartedAt: null, submittedAt: null });
  return cases.get(name);
}
function timing(state) {
  const duration = state.name === 'deadline' ? 3 : 180;
  return { remainingSeconds: state.startedAt ? Math.max(0, duration - (Date.now() - state.startedAt) / 1000) : duration,
    examEndAt: state.startedAt ? new Date(state.startedAt + duration * 1000).toISOString() : null };
}
function finish(state) { state.submittedAt ||= new Date().toISOString(); return { success: true, examComplete: true, autoSubmitted: true, submitted: true, status: 'SUBMITTED', submittedAt: state.submittedAt, examTiming: timing(state) }; }
function current(state) {
  if (state.submittedAt) return finish(state);
  return { success: true, question: questions[state.position], subject, subjectIndex: 0, questionIndex: state.position,
    sequenceNumber: state.position + 1, selectedOption: state.answers.get(questions[state.position].id) ?? null,
    remainingSeconds: Math.max(0, questionSeconds(state) - (Date.now() - state.questionStartedAt) / 1000), examTiming: timing(state) };
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const candidate = path.resolve(root, 'dist', relative);
      if (!candidate.startsWith(path.join(root, 'dist') + path.sep) && candidate !== path.join(root, 'dist')) { response.writeHead(403); response.end(); return; }
      const file = path.extname(candidate) ? candidate : path.join(root, 'dist', 'index.html');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
      let content;
      try { content = await readFile(file); } catch { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(content); return;
    }
    const state = fixture(request.headers['x-smoke-case'] || 'normal');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw && (request.headers['content-type'] || '').includes('application/json') ? JSON.parse(raw) : {};
    requests.push({ case: state.name, method: request.method, path: url.pathname, body });
    let result; let status = 200;
    switch (url.pathname) {
      case '/api/exam/auth/login': {
        if (state.logins++) { status = 409; result = { message: 'Your exam is already active on another device.', code: 'SESSION_ACTIVE' }; break; }
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        result = { success: true, token: `e30.${payload}.fixture`, student: { id: 1, name: 'Browser Student', registrationId: `SMOKE-${state.name}`, hallTicketNumber: 'HT-001', class: '10', examDate: 'Test fixture', examName: exam.examName } }; break;
      }
      case '/api/exam/settings': result = { settings: settingsFor(state) }; break;
      case '/api/exam/system-check/screenshot': state.photoUploaded = true; result = { success: true, captured: true }; break;
      case '/api/exam/info': result = { success: true, exam, subjects: [subject], attempt: state.startedAt ? { status: state.submittedAt ? 'SUBMITTED' : 'IN_PROGRESS', submittedAt: state.submittedAt } : null }; break;
      case '/api/exam/mock-video': result = { video: null }; break;
      case '/api/exam/rules': result = { rules: [{ id: 1, text: 'Read and accept the test fixture examination rules.' }] }; break;
      case '/api/exam/preflight/system-check':
        assert.equal(body.microphone, true);
        if (state.name === 'devices') { assert.equal(body.camera, true); assert.equal(body.fullscreen, true); assert.equal(state.photoUploaded, true); }
        result = { success: true, systemCheckCompleted: true }; break;
      case '/api/exam/preflight/rules-accepted': result = { success: true }; break;
      case '/api/exam/session/start':
        state.startedAt ||= Date.now(); state.questionStartedAt ||= Date.now();
        result = { success: true, session: { id: `attempt-${state.name}`, status: state.submittedAt ? 'SUBMITTED' : 'IN_PROGRESS', submittedAt: state.submittedAt }, exam, examTiming: timing(state) }; break;
      case '/api/exam/current-question': result = current(state); break;
      case '/api/exam/navigation': result = { success: true, questions: questions.map((question, index) => ({ id: question.id, sequenceNumber: index + 1, subjectKey: subject.subjectKey, locked: state.locked.has(question.id), answer: state.answers.get(question.id) ?? null })) }; break;
      case '/api/exam/answers/draft':
        assert.equal(body.questionId, questions[state.position].id); state.answers.set(body.questionId, body.selectedOption); result = { success: true, selectedOption: body.selectedOption }; break;
      case '/api/exam/answers': {
        assert.equal(body.questionId, questions[state.position].id);
        if ((Date.now() - state.questionStartedAt) / 1000 < questionSeconds(state)) state.answers.set(body.questionId, body.selectedOption);
        state.locked.add(body.questionId);
        if (timing(state).remainingSeconds <= 0 || state.position === questions.length - 1) result = finish(state);
        else { state.position += 1; state.questionStartedAt = Date.now(); const next = current(state); result = { ...next, question: undefined, nextQuestion: { ...next.question, subject }, nextSubjectIndex: 0, nextQuestionIndex: state.position }; }
        break;
      }
      case '/api/exam/session/submit': result = finish(state); break;
      case '/api/exam/proctoring/event':
        // Only the 'violations' case records events, like the real backend
        // (capture only: no limit, never blocks); every other case has
        // proctoring off.
        if (state.name !== 'violations') { result = { success: true, recorded: false }; break; }
        state.violations = (state.violations || 0) + 1;
        result = { success: true, recorded: true, violation: true, violationCount: state.violations, blocked: false }; break;
      case '/api/exam/result': result = { success: true, submitted: Boolean(state.submittedAt), published: false, completion: state.submittedAt ? { submittedAt: state.submittedAt, totalQuestions: questions.length, attemptedQuestions: [...state.answers.values()].filter(Boolean).length, examName: exam.examName } : null }; break;
      default:
        if (url.pathname.includes('branding')) result = { branding: { examName: exam.examName } };
        else if (url.pathname.includes('/auth/') || url.pathname === '/api/exam/presence' || url.pathname === '/api/exam/proctoring/event') result = { success: true, recorded: false };
        else { status = 404; result = { message: `Unknown fixture endpoint ${url.pathname}` }; }
    }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: error.message })); }
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
          return realFetch(location.origin + url.pathname + url.search, { ...init, headers: { ...init.headers, 'X-Smoke-Case': window.__smokeCase } });
        }
        return realFetch(input, init);
      };
      const NativeAudioContext = window.AudioContext;
      window.__smokeContexts = [];
      window.AudioContext = class extends NativeAudioContext { constructor(...args) { super(...args); window.__smokeContexts.push(this); } };
      let sourceContext, gain, destination;
      const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints.video && !constraints.audio && window.__smokeCase === 'devices') return realGetUserMedia(constraints);
        if (!constraints.audio) throw new Error('This smoke fixture enables microphone only');
        if (!sourceContext) { sourceContext = new NativeAudioContext(); const oscillator = sourceContext.createOscillator(); gain = sourceContext.createGain(); gain.gain.value = 0; destination = sourceContext.createMediaStreamDestination(); oscillator.connect(gain); gain.connect(destination); oscillator.start(); await sourceContext.resume(); }
        return destination.stream.clone();
      };
      window.__smokeSound = async (enabled) => { gain.gain.value = enabled ? 0.15 : 0; await sourceContext.resume(); };
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
    const login = async () => {
      await send('Page.navigate', { url: origin }, sessionId);
      await wait('!!document.querySelector("#registrationId")', 'login inputs');
      await evaluate(`for (const [id, value] of [['registrationId', 'SMOKE'], ['hallTicket', 'HT-001']]) { const input = document.getElementById(id); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }`);
      await click('Login');
    };
    // Waits for the NEW document, never the page that was being reloaded.
    const reload = async () => {
      const before = dialogs.length;
      await evaluate('window.__smokeBeforeReload = true');
      await send('Page.reload', {}, sessionId);
      await wait('!window.__smokeBeforeReload && document.readyState === "complete"', 'reloaded document');
      return dialogs.slice(before);
    };
    return { sessionId, evaluate, wait, click, login, reload };
  }
  async function enterExam(p) {
    await p.login(); await p.wait('location.pathname === "/student-confirm"', 'student confirmation'); await p.click('Continue to Dashboard');
    await p.wait('location.pathname === "/dashboard"', 'dashboard'); await p.evaluate('document.querySelector("input[type=checkbox]").click()'); await p.click('Start Examination');
    await p.wait('location.pathname === "/system-check" && !!document.querySelector("[role=meter]")', 'microphone system check');
    await p.wait('window.__smokeContexts.length > 0', 'microphone audio context');
    await p.wait('document.querySelector("[role=meter]").getAttribute("aria-valuenow") === "0"', 'silent microphone meter');
    assert.equal(await p.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.includes("I Agree")).disabled'), true, 'silence must prevent continuing');
    await p.evaluate('window.__smokeContexts[0].suspend()'); await p.click('Start Microphone Test');
    await p.evaluate('window.__smokeSound(true)');
    await p.wait('document.body.innerText.includes("Your microphone test passed")', 'real Web Audio input proof');
    assert.ok(await p.evaluate('Number(document.querySelector("[role=meter]").getAttribute("aria-valuenow"))') > 0);
    if (p.devices) {
      await p.wait('!!document.querySelector("video") && document.querySelector("video").readyState >= 2', 'fake camera frames');
      await p.click('Enter Fullscreen'); await p.wait('!!document.fullscreenElement', 'fullscreen entered');
    }
    await p.click('I Agree'); await p.click('Start Exam'); await p.wait('location.pathname === "/proctoring-rules"', 'rules'); await p.click('Continue to Exam');
    await p.wait('!!document.querySelector("#active-question")', 'first question');
  }
  const normal = await page('normal'); await enterExam(normal);
  assert.equal(await normal.evaluate('document.querySelector("#active-question").textContent'), questions[0].questionText);
  assert.equal(await normal.evaluate('Array.from(document.querySelectorAll("button")).some(button => /Previous|Bookmark|Mark (as|for) review/i.test(button.textContent))'), false);
  assert.equal(await normal.evaluate('Array.from(document.querySelectorAll(".exam-side-actions button")).map(button => button.textContent.trim()).join(",")'), 'Review the Exam,Submit the Exam');
  assert.equal(await normal.evaluate('document.querySelector(".exam-side-actions").getBoundingClientRect().bottom <= document.querySelector(".exam-proctor-panel").getBoundingClientRect().top'), true, 'Review/Submit sit above the proctoring monitor');
  assert.equal(await normal.evaluate('[".subject-summary-name", ".subject-summary-count"].map(sel => document.querySelector(".subject-summary-card " + sel).textContent.trim()).join(" ")'), 'Mathematics 0 / 3 Answered');
  await normal.evaluate('document.querySelectorAll("input[type=radio]")[1].click()');
  await normal.wait('document.body.innerText.includes("Answer saved.")', 'answer draft save');
  assert.equal(await normal.evaluate('[".subject-summary-name", ".subject-summary-count"].map(sel => document.querySelector(".subject-summary-card " + sel).textContent.trim()).join(" ")'), 'Mathematics 1 / 3 Answered', 'subject count updates as the student answers');
  assert.equal(await normal.evaluate('document.querySelectorAll(".subject-question-grid button, .subject-question-grid a").length'), 0, 'subject grid is status only');
  assert.equal(await normal.evaluate('Array.from(document.querySelectorAll(".exam-actions-row button")).find(button => button.textContent.trim() === "Skip").disabled'), true, 'Skip is disabled once an answer is selected');
  await normal.click('Review'); await normal.wait('!!document.querySelector(".review-modal")', 'review modal');
  assert.equal(await normal.evaluate('Array.from(document.querySelectorAll(".review-cell")).map(cell => cell.className.replace("review-cell", "").trim()).join("|")'), 'current answered|upcoming|upcoming');
  await normal.click('Continue Exam'); await normal.wait('!document.querySelector(".review-modal")', 'review closed');
  await normal.evaluate('history.back()'); await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await normal.evaluate('location.pathname'), '/exam', 'browser Back cannot leave the exam');
  assert.equal(await normal.evaluate('document.querySelector("#active-question").textContent'), questions[0].questionText);
  assert.deepEqual(await normal.reload(), ['beforeunload'], 'the exam page still guards against accidental reload');
  await normal.wait('!!document.querySelector("#active-question")', 'question restored after refresh');
  assert.equal(await normal.evaluate('document.querySelector("#active-question").textContent'), questions[0].questionText);
  assert.equal(await normal.evaluate('document.querySelectorAll("input[type=radio]")[1].checked'), true, 'answer restored by question ID');
  await normal.click('Next'); await normal.wait(`document.querySelector('#active-question')?.textContent === ${JSON.stringify(questions[1].questionText)}`, 'second fixed question');
  await normal.evaluate('window.__smokeDropNextDraft = true; document.querySelectorAll("input[type=radio]")[2].click()');
  await normal.wait('document.body.innerText.includes("Answer pending")', 'pending answer after network failure');
  await normal.evaluate('window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online"))');
  await normal.wait('document.body.innerText.includes("Answer saved.")', 'reconnected answer save');
  assert.equal(fixture('normal').answers.get(questions[1].id), 'C');
  const secondDevice = await page('normal', true); await secondDevice.login(); await secondDevice.wait('document.body.innerText.includes("already active on another device")', 'second-device conflict message');
  await send('Page.bringToFront', {}, normal.sessionId);
  await normal.click('Next'); await normal.wait(`document.querySelector('#active-question')?.textContent === ${JSON.stringify(questions[2].questionText)}`, 'third fixed question');
  await normal.evaluate('document.querySelectorAll("input[type=radio]")[0].click()'); await normal.click('Save & Submit');
  await normal.wait('document.body.innerText.includes("Exam Completed Successfully")', 'completion page');
  assert.equal(fixture('normal').submittedAt !== null, true);
  assert.deepEqual([...fixture('normal').answers], [[303, 'B'], [101, 'C'], [202, 'A']]);
  console.log('PASS: login, confirmation, dashboard, silent mic gate, gesture activation, real audio detection, rules, fixed sequence, draft restore, reconnect, second-device message, submission/completion.');
  const deadline = await page('deadline', true); await enterExam(deadline);
  await deadline.evaluate('document.querySelectorAll("input[type=radio]")[3].click()');
  await deadline.wait('document.body.innerText.includes("Exam Completed Successfully")', 'automatic deadline submission', 8000);
  assert.equal(fixture('deadline').answers.get(303), 'D');
  assert.equal(fixture('deadline').submittedAt !== null, true);
  console.log('PASS: server-anchored exam countdown automatically saves the current answer and completes the attempt.');

  const offline = await page('offline', true); await enterExam(offline);
  await offline.wait('document.body.innerText.includes("remaining for this question!") && document.querySelector(`[aria-label="Question time remaining"]`).classList.contains("timer-final")', 'question 20-second warning');
  await offline.evaluate('document.querySelectorAll("input[type=radio]")[1].click()');
  await offline.wait('document.body.innerText.includes("Answer saved.")', 'draft saved before going offline');
  await offline.evaluate('window.__smokeOffline = true; window.dispatchEvent(new Event("offline"))');
  await offline.wait("document.querySelector(\"[aria-label='Question time remaining'] span\")?.textContent === \"00:00\"", 'question timer expired while offline', 10000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await offline.evaluate('document.querySelector("#active-question").textContent'), questions[0].questionText, 'no advance while offline');
  await offline.evaluate('window.__smokeOffline = false; window.dispatchEvent(new Event("online"))');
  await offline.wait(`document.querySelector('#active-question')?.textContent === ${JSON.stringify(questions[1].questionText)}`, 'automatic advance after reconnect', 10000);
  assert.equal(fixture('offline').answers.get(questions[0].id), 'B', 'the timely draft is kept');
  assert.equal(fixture('offline').locked.has(questions[0].id), true);
  assert.equal(fixture('offline').logins, 1, 'reconnecting needs no new login');
  console.log('PASS: a question that expires while offline advances automatically on reconnect, keeping the saved draft.');

  const devices = await page('devices', true); devices.devices = true; await enterExam(devices);
  assert.equal(await devices.evaluate('!!document.fullscreenElement'), true, 'exam runs in fullscreen');
  assert.equal(await devices.evaluate('!!document.querySelector(".exam-camera-preview video")?.srcObject'), true, 'camera feed shown during the exam');
  await devices.evaluate('document.querySelectorAll("input[type=radio]")[2].click()');
  await devices.wait('document.body.innerText.includes("Answer saved.")', 'devices draft save');
  assert.deepEqual(await devices.reload(), ['beforeunload']);
  await devices.wait('!!document.querySelector("#active-question")', 'devices question restored after refresh');
  // Headless Chromium keeps fullscreen across a reload (a desktop browser
  // drops it); either way the overlay must match the real state.
  assert.equal(await devices.evaluate('document.body.innerText.includes("Full-Screen Mode Required") === !document.fullscreenElement'), true);
  // Leaving fullscreen (Esc) blocks the exam behind the overlay and is reported.
  if (await devices.evaluate('!!document.fullscreenElement')) await devices.evaluate('document.exitFullscreen()');
  await devices.wait('document.body.innerText.includes("Full-Screen Mode Required")', 'fullscreen overlay after leaving fullscreen');
  await devices.wait('true', 'settle');
  assert.ok(requests.some((entry) => entry.case === 'devices' && entry.body?.eventType === 'FULLSCREEN_EXIT'), 'fullscreen exit reported');
  await devices.click('Return to Full Screen');
  await devices.wait('!!document.fullscreenElement && !document.body.innerText.includes("Full-Screen Mode Required")', 'fullscreen restored');
  assert.equal(await devices.evaluate('document.querySelector("#active-question").textContent'), questions[0].questionText);
  assert.equal(await devices.evaluate('document.querySelectorAll("input[type=radio]")[2].checked'), true);
  for (const index of [0, 1]) {
    await devices.click('Next');
    await devices.wait(`document.querySelector('#active-question')?.textContent === ${JSON.stringify(questions[index + 1].questionText)}`, `devices question ${index + 2}`);
    await devices.evaluate('document.querySelectorAll("input[type=radio]")[0].click()');
    await devices.wait('document.body.innerText.includes("Answer saved.")', `devices answer ${index + 2}`);
  }
  await devices.click('Save & Submit');
  await devices.wait('document.body.innerText.includes("Exam Completed Successfully")', 'devices completion page');
  assert.equal(fixture('devices').photoUploaded, true);
  assert.deepEqual([...fixture('devices').answers], [[303, 'C'], [101, 'A'], [202, 'A']]);
  console.log('PASS: camera, check-in photo and fullscreen required; fullscreen recovery after refresh; submission.');

  const early = await page('early', true); await enterExam(early);
  // Next with no answer asks first; "Go Back" stays on the same question.
  await early.click('Next');
  await early.wait('document.body.innerText.includes("No answer is selected. Do you want to continue?")', 'no-answer warning');
  await early.click('Go Back');
  await early.wait('!document.body.innerText.includes("No answer is selected")', 'warning closed');
  assert.equal(await early.evaluate('document.querySelector("#active-question").textContent'), questions[0].questionText, 'Go Back keeps the question');
  assert.equal(fixture('early').position, 0, 'nothing was locked or advanced');
  await early.evaluate('document.querySelectorAll("input[type=radio]")[2].click()');
  await early.wait('document.body.innerText.includes("Answer saved.")', 'early draft save');
  await early.click('Submit'); await early.wait('document.body.innerText.includes("Submit Examination?")', 'submit confirmation');
  assert.equal(await early.evaluate('document.body.innerText.includes("You have answered 1 of 3 questions. 2 questions will be submitted as unanswered.")'), true);
  await early.click('Confirm Submission');
  await early.wait('document.body.innerText.includes("Exam Completed Successfully")', 'early submission completion page');
  assert.equal(fixture('early').submittedAt !== null, true);
  assert.deepEqual([...fixture('early').answers], [[303, 'C']]);
  console.log('PASS: review, subject-wise counts, back navigation blocked, early submission through the secure submit endpoint.');

  const violations = await page('violations', true); await enterExam(violations);
  const rightClick = 'document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))';
  await violations.evaluate(rightClick);
  await violations.wait('document.body.innerText.includes("Right-Click Used") && document.body.innerText.includes("Violation Recorded")', 'right-click violation popup');
  assert.equal(await violations.evaluate('/\\d\\/3|Warning \\d/.test(document.querySelector(".violation-card").innerText)'), false, 'no N/3 count in the popup');
  await violations.click('I Understand'); await violations.wait('!document.querySelector(".violation-card")', 'popup dismissed');
  await violations.evaluate('window.dispatchEvent(new Event("blur"))');
  await violations.wait('document.body.innerText.includes("Exam Window Left") && document.body.innerText.includes("Violation Recorded")', 'second violation popup');
  await violations.click('I Understand');
  await new Promise((resolve) => setTimeout(resolve, 3200)); // the page's own right-click coalescing window
  await violations.evaluate(rightClick);
  await violations.wait('document.body.innerText.includes("Right-Click Used") && !!document.querySelector(".violation-card")', 'third violation popup');
  await violations.click('I Understand');
  assert.equal(fixture('violations').violations, 3, 'every violation is recorded');
  assert.equal(await violations.evaluate('!!document.querySelector("#active-question") && !document.body.innerText.includes("Examination Blocked")'), true, 'the exam continues after any number of violations');
  // Next with no answer -> "Continue" moves on, leaving the question unanswered.
  await violations.click('Next');
  await violations.wait('document.body.innerText.includes("No answer is selected. Do you want to continue?")', 'no-answer warning');
  await violations.click('Continue');
  await violations.wait(`document.querySelector('#active-question')?.textContent === ${JSON.stringify(questions[1].questionText)}`, 'advanced without an answer');
  assert.equal(fixture('violations').locked.has(questions[0].id), true);
  assert.equal(fixture('violations').answers.get(questions[0].id) ?? null, null, 'left unanswered');
  console.log('PASS: Next without an answer warns; Go Back stays, Continue moves on unanswered.');
  console.log('PASS: violations are captured with a reason popup (no N/3); the exam is never blocked.');

  assert.deepEqual(exceptions, [], 'browser must not throw JavaScript exceptions');
  assert.deepEqual(dialogs.filter((type) => type !== 'beforeunload'), [], 'no unexpected dialogs');
  console.log('LIMIT: API/database behavior uses an isolated fixture; face recognition, the proctoring video, real camera hardware and a physical microphone require a staging/manual run.');
} catch (error) {
  console.error(error.stack); console.error('Recent fixture requests:', JSON.stringify(requests.slice(-12))); process.exitCode = 1;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise((resolve) => { chrome.once('exit', resolve); setTimeout(resolve, 3000); }); }
  await new Promise((resolve) => server.close(resolve));
  const resolvedProfile = path.resolve(profile);
  if (path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('gtst-browser-flow-')) await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
