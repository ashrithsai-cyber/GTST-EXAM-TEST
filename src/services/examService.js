import { apiGet, apiPost, apiUpload } from '../components/utils/api';

// Starts (or, if one already exists, resumes) the authenticated student's
// session for the active exam. Safe to call every time the exam page
// mounts — including after a refresh, since the backend never resets an
// IN_PROGRESS session's position or timer here.
export function startExamSession(token) {
  return apiPost('/api/exam/session/start', undefined, token);
}

// The single question the backend's session pointer currently considers
// "active" for this student (options only, never the answer). There is
// no way to fetch any other question — the server only ever resolves
// exactly the current (or, via saveExamAnswer's `nextQuestion`, the
// about-to-become-current) one, so a student's client never holds
// content for a question it hasn't reached yet.
export function fetchCurrentQuestion(token) {
  return apiGet('/api/exam/current-question', token);
}

export function fetchExamNavigation(token, sessionId) {
  return apiGet(`/api/exam/navigation?sessionId=${encodeURIComponent(sessionId)}`, token);
}

export function updateExamAnswer(token, payload) {
  return apiPost('/api/exam/answers/draft', payload, token);
}

// Reports a proctoring event (tab switch, fullscreen exit, camera/mic
// loss, face-detection issues, etc). Callers must only surface a "this
// was recorded" message to the student once this promise resolves
// successfully — never assume the backend saved it.
export function recordProctoringEvent(token, { sessionId, eventType, eventMessage }) {
  return apiPost('/api/exam/proctoring/event', { sessionId, eventType, eventMessage }, token);
}

// Saves the answer for whichever question the backend currently considers
// "current" for this session, then advances the session to the next one.
// selectedOption may be null (question timed out unanswered).
export function saveExamAnswer(token, { sessionId, questionId, selectedOption, timeSpentSeconds }) {
  return apiPost('/api/exam/answers', { sessionId, questionId, selectedOption, timeSpentSeconds }, token);
}

export function submitExamSession(token, sessionId) {
  return apiPost('/api/exam/session/submit', { sessionId }, token);
}

// The exam process video shown on the Proctoring Rules page — whatever
// the admin most recently uploaded via the Mock Video panel. Returns
// { video: null } if nothing has been uploaded yet, not an error.
export function fetchMockVideo(token) {
  return apiGet('/api/exam/mock-video', token);
}

// Live exam metadata (name, timer, section/question counts) for the
// pre-exam Student Dashboard — never the question text/options
// themselves (see GET /questions for that, fetched only once the
// student actually enters the exam flow).
export function fetchExamInfo(token) {
  return apiGet('/api/exam/info', token);
}

// Admin-controlled requirement flags (camera/mic/fullscreen/proctoring/
// face detection/video/network monitoring/tab-switch monitoring) — the
// single source of truth for what this exam actually requires, so a
// disabled check here is really skipped, not just hidden in the UI.
export function fetchExamSettings(token) {
  return apiGet('/api/exam/settings', token);
}

// The proctoring rules shown on the Exam Proctoring & Rules page —
// whatever the admin has configured and marked active (Admin >
// Proctoring Rules), in the admin's chosen order. Returns
// { rules: [{ id, text }] }; an empty array (nothing configured, or the
// rules table not migrated yet) means the page should fall back to its
// bundled default rules, never show an empty list.
export function fetchProctoringRules(token) {
  return apiGet('/api/exam/rules', token);
}

// Display-only stage ping for the admin Live Students page (System Check
// / Watching Rules-Video — the two pages with no other backend
// touchpoint of their own; Logged In/In Exam/Completed are recorded
// server-side instead). Never security-sensitive — safe to call and
// ignore the result.
export function recordPresence(token, stage) {
  return apiPost('/api/exam/presence', { stage }, token);
}

// Registers a completed System Check with the backend — the server-side
// record POST /session/start requires before creating a session (the
// browser's own "checks passed" flag alone is never trusted). checks is
// { camera, microphone, fullscreen, face } booleans.
export function submitSystemCheck(token, checks) {
  return apiPost('/api/exam/preflight/system-check', checks, token);
}

// Records that the student accepted the proctoring rules (after the
// System Check above) — also required before a session can start.
export function acceptProctoringRules(token) {
  return apiPost('/api/exam/preflight/rules-accepted', undefined, token);
}

// The student's own result for their latest submitted exam — only
// populated once the administrator has published results
// ({ published: false } until then).
export function fetchMyResult(token) {
  return apiGet('/api/exam/result', token);
}

// Uploads the check-in photo captured during System Check. A later
// capture for the same candidate/exam replaces the earlier photo.
export function uploadSystemCheckScreenshot(token, blob) {
  const formData = new FormData();
  formData.append('screenshot', blob, 'system-check.jpg');
  return apiUpload('/api/exam/system-check/screenshot', formData, token);
}
