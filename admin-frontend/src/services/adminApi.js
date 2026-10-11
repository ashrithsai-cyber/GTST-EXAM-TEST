// Thin wrappers around every backend/src/routes/admin.routes.js endpoint.
// Each admin page component (src/components/admin/*) calls these instead
// of holding its own mock local state.
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiUpload, apiDownload, apiGetBlob } from "./apiClient";

// A page limit high enough to cover this exam's realistic scale (a
// scholarship test, not mass traffic) in a single request; the backend
// caps ?limit= at 100 regardless (see parsePagination in
// backend/src/controllers/admin.controller.js).
const MAX_PAGE_SIZE = 100;

// =====================================================
// DASHBOARD
// =====================================================

export const getDashboard = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return apiGet(`/api/admin/dashboard${query ? `?${query}` : ""}`);
};

// =====================================================
// CANDIDATES
// =====================================================

export const listCandidates = (params = {}) => {
  const query = new URLSearchParams({ limit: MAX_PAGE_SIZE, ...params }).toString();
  return apiGet(`/api/admin/candidates?${query}`);
};

export const getCandidate = (candidateId) => apiGet(`/api/admin/candidates/${candidateId}`);

// The student's single active device lease. Releasing it never logs the
// admin in as the student; the student must sign in again themselves.
export const getCandidateDeviceSession = (candidateId) =>
  apiGet(`/api/admin/candidates/${candidateId}/device-session`);
export const releaseCandidateDeviceSession = (candidateId, reason) =>
  apiPost(`/api/admin/candidates/${candidateId}/device-session/release`, { reason });

// =====================================================
// EXAMS
// =====================================================

export const listExams = () => apiGet("/api/admin/exams");
export const createExam = (payload) => apiPost("/api/admin/exams", payload);
export const getExam = (examId) => apiGet(`/api/admin/exams/${examId}`);
export const updateExam = (examId, payload) => apiPut(`/api/admin/exams/${examId}`, payload);
export const updateExamStatus = (examId, status) =>
  apiPatch(`/api/admin/exams/${examId}/status`, { status });
export const updateResultsPublication = (examId, published) =>
  apiPatch(`/api/admin/exams/${examId}/results-publication`, { published });
export const resetExamAttempts = (examId) =>
  apiPost(`/api/admin/exams/${examId}/reset-attempts`, {});
export const deleteExam = (examId) => apiDelete(`/api/admin/exams/${examId}`);

// =====================================================
// CLASSES
// =====================================================

export const listClasses = (examId) => apiGet(`/api/admin/exams/${examId}/classes`);
export const createClass = (examId, payload) =>
  apiPost(`/api/admin/exams/${examId}/classes`, payload);
export const updateClass = (classId, payload) => apiPut(`/api/admin/classes/${classId}`, payload);
export const deleteClass = (classId) => apiDelete(`/api/admin/classes/${classId}`);

// =====================================================
// SUBJECTS
// =====================================================

export const listSubjects = (classId) => apiGet(`/api/admin/classes/${classId}/subjects`);
export const createSubject = (classId, payload) =>
  apiPost(`/api/admin/classes/${classId}/subjects`, payload);
export const updateSubject = (subjectId, payload) =>
  apiPut(`/api/admin/subjects/${subjectId}`, payload);
export const deleteSubject = (subjectId) => apiDelete(`/api/admin/subjects/${subjectId}`);

// =====================================================
// QUESTIONS
// =====================================================

export const listQuestions = (subjectId) => apiGet(`/api/admin/subjects/${subjectId}/questions`);
export const createQuestion = (subjectId, payload) =>
  apiPost(`/api/admin/subjects/${subjectId}/questions`, payload);
export const updateQuestion = (questionId, payload) =>
  apiPut(`/api/admin/questions/${questionId}`, payload);
export const deleteQuestion = (questionId) => apiDelete(`/api/admin/questions/${questionId}`);

export const downloadQuestionTemplate = () =>
  apiDownload("/api/admin/question-template", "question-upload-template.xlsx");

export const importQuestionsExcel = (subjectId, file) => {
  const formData = new FormData();
  formData.append("file", file);
  return apiUpload(`/api/admin/subjects/${subjectId}/questions/import`, formData);
};

// =====================================================
// SESSIONS
// =====================================================

export const listSessions = (params = {}) => {
  const query = new URLSearchParams({ limit: MAX_PAGE_SIZE, ...params }).toString();
  return apiGet(`/api/admin/sessions?${query}`);
};

export const getSession = (sessionId) => apiGet(`/api/admin/sessions/${sessionId}`);
export const getSessionResult = (sessionId) => apiGet(`/api/admin/sessions/${sessionId}/result`);
// Every question in one attempt with options, the selection, the correct
// option and the result (admin.controller.js getSessionAnswerSheet).
export const getSessionAnswerSheet = (sessionId) => apiGet(`/api/admin/sessions/${sessionId}/answer-sheet`);

// =====================================================
// RESULTS
// =====================================================

export const listResults = (params = {}) => {
  const query = new URLSearchParams({ limit: MAX_PAGE_SIZE, ...params }).toString();
  return apiGet(`/api/admin/results?${query}`);
};
export const exportResultsCsv = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return apiDownload(`/api/admin/results/export.csv${query ? `?${query}` : ""}`, "gtst-exam-results.csv");
};
export const exportResultsXlsx = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return apiDownload(`/api/admin/results/export.xlsx${query ? `?${query}` : ""}`, "gtst-exam-results.xlsx");
};

// =====================================================
// PROCTORING / VIOLATIONS
// =====================================================

export const listProctoringEvents = (params = {}) => {
  const query = new URLSearchParams({ limit: MAX_PAGE_SIZE, ...params }).toString();
  return apiGet(`/api/admin/proctoring/events?${query}`);
};

export const exportProctoringEventsCsv = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return apiDownload(`/api/admin/proctoring/events/export.csv${query ? `?${query}` : ""}`, "gtst-proctoring-violations.csv");
};

export const exportProctoringEventsXlsx = (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return apiDownload(`/api/admin/proctoring/events/export.xlsx${query ? `?${query}` : ""}`, "gtst-proctoring-violations.xlsx");
};

export const summarizeMonitoringEvents = (sessionIds) =>
  apiPost("/api/admin/proctoring/event-summaries", { sessionIds });

export const reviewProctoringEvent = (eventId) =>
  apiPatch(`/api/admin/proctoring/events/${eventId}/review`, {});

// =====================================================
// AUDIT LOGS
// =====================================================

export const listAuditLogs = (params = {}) => {
  const query = new URLSearchParams({ limit: MAX_PAGE_SIZE, ...params }).toString();
  return apiGet(`/api/admin/audit-logs?${query}`);
};

// =====================================================
// ADMIN USERS — every authenticated admin can manage admin accounts.
// =====================================================

export const listAdminUsers = () => apiGet("/api/admin/users");
export const createAdminUser = (payload) => apiPost("/api/admin/users", payload);
export const updateAdminUser = (adminId, payload) => apiPut(`/api/admin/users/${adminId}`, payload);
export const updateAdminUserStatus = (adminId, isActive) =>
  apiPatch(`/api/admin/users/${adminId}/status`, { isActive });

// =====================================================
// MOCK VIDEO
// =====================================================

export const getMockVideo = () => apiGet("/api/admin/mock-video");

export const uploadMockVideo = (file, { title, description } = {}) => {
  const formData = new FormData();
  formData.append("video", file);
  if (title !== undefined) formData.append("title", title);
  if (description !== undefined) formData.append("description", description);
  return apiUpload("/api/admin/mock-video", formData);
};

export const updateMockVideoDetails = (payload) =>
  apiPut("/api/admin/mock-video/details", payload);

export const deleteMockVideo = () => apiDelete("/api/admin/mock-video");

// =====================================================
// EXAM BRANDING — name + logo shown across the entire student portal
// (header, footer, login page, exam-taking header). Every authenticated
// admin can view and change it.
// =====================================================

export const getBranding = () => apiGet("/api/admin/branding");
export const updateBrandingName = (examName) => apiPut("/api/admin/branding", { examName });

export const uploadBrandingLogo = (file) => {
  const formData = new FormData();
  formData.append("logo", file);
  return apiUpload("/api/admin/branding/logo", formData);
};

// =====================================================
// EXAM SETTINGS — system-requirement toggles (camera, microphone,
// fullscreen, face recognition, etc). Read by every student on login via
// GET /api/exam/settings (see SystemCheckContext.jsx); this is the admin
// side that changes them. Every authenticated admin can manage it.
// =====================================================

export const getExamSettings = () => apiGet("/api/admin/settings");
export const updateExamSettings = (payload) => apiPut("/api/admin/settings", payload);

// =====================================================
// CAPTURED IMAGES — automatic System Check check-in screenshots
// (registration ID, exam, timestamp). The bucket behind these is
// private, so images are never a plain <img src> URL — the caller must
// fetch the blob (with the admin's auth header) and turn it into an
// object URL itself.
// =====================================================

export const listCheckInScreenshots = (params = {}) => {
  const query = new URLSearchParams({ limit: 24, ...params }).toString();
  return apiGet(`/api/admin/system-check-screenshots?${query}`);
};

export const fetchCheckInScreenshotBlob = (id) =>
  apiGetBlob(`/api/admin/system-check-screenshots/${id}/image`);
