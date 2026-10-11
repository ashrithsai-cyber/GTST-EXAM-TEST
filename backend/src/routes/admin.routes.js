const express = require("express");
const adminJwtAuth = require("../middleware/adminJwtAuth");

const {
    getDashboard,
    listCandidates,
    getCandidate,
    getCandidateDeviceSession,
    releaseCandidateDeviceSession,
    listExams,
    createExam,
    getExam,
    updateExam,
    updateExamStatus,
    updateResultsPublication,
    resetExamAttempts,
    deleteExam,
    listClasses,
    createClass,
    updateClass,
    deleteClass,
    listSubjects,
    createSubject,
    updateSubject,
    deleteSubject,
    listQuestions,
    createQuestion,
    getQuestion,
    updateQuestion,
    deleteQuestion,
    listSessions,
    getSession,
    getSessionResult,
    getSessionAnswerSheet,
    listResults,
    exportResultsCsv,
    exportResultsXlsx,
    listProctoringEvents,
    exportProctoringEventsCsv,
    exportProctoringEventsXlsx,
    summarizeMonitoringEvents,
    reviewProctoringEvent,
    listAuditLogs,
    listAdminUsers,
    createAdminUser,
    updateAdminUser,
    updateAdminUserStatus
} = require("../controllers/admin.controller");
const {
    getMockVideo,
    uploadMockVideo,
    updateMockVideoDetails,
    deleteMockVideo
} = require("../controllers/mockVideo.controller");
const { getSettings, updateSettings } = require("../controllers/settings.controller");
const { getRules, createRule, updateRule, deleteRule } = require("../controllers/rules.controller");
const { getBranding, updateBrandingName, uploadBrandingLogo } = require("../controllers/branding.controller");
const { downloadQuestionTemplate, importQuestions } = require("../controllers/questionImport.controller");
const { listCheckInScreenshots, getCheckInScreenshotImage } = require("../controllers/screenshot.controller");
const upload = require("../middleware/upload");
const { adminUploadLimiter } = require("../middleware/rateLimiters");
const { isUuid } = require("../utils/validation");

const router = express.Router();

// Every route below requires a valid, active admin JWT (re-checked
// against admin_users.is_active on every request).
router.use(adminJwtAuth);

// Every id in the exam database is a uuid — a malformed one is a clean
// 404 here instead of a Postgres "invalid input syntax" 500.
for (const param of ["examId", "classId", "subjectId", "questionId", "sessionId", "eventId", "adminId", "candidateId", "ruleId", "id"]) {
    router.param(param, (req, res, next, value) => {
        if (!isUuid(value)) return res.status(404).json({ success: false, message: "Not found" });
        return next();
    });
}

router.get("/dashboard", getDashboard);

router.get("/candidates", listCandidates);
router.get("/candidates/:candidateId", getCandidate);
router.get("/candidates/:candidateId/device-session", getCandidateDeviceSession);
router.post("/candidates/:candidateId/device-session/release", releaseCandidateDeviceSession);

router.get("/exams", listExams);
router.post("/exams", createExam);
router.get("/exams/:examId", getExam);
router.put("/exams/:examId", updateExam);
router.patch("/exams/:examId/status", updateExamStatus);
router.patch("/exams/:examId/results-publication", updateResultsPublication);
router.post("/exams/:examId/reset-attempts", resetExamAttempts);
router.delete("/exams/:examId", deleteExam);

router.get("/exams/:examId/classes", listClasses);
router.post("/exams/:examId/classes", createClass);
router.put("/classes/:classId", updateClass);
router.delete("/classes/:classId", deleteClass);

router.get("/classes/:classId/subjects", listSubjects);
router.post("/classes/:classId/subjects", createSubject);
router.put("/subjects/:subjectId", updateSubject);
router.delete("/subjects/:subjectId", deleteSubject);

// Deliberately a top-level path, not nested under /questions/:questionId,
// so it can never collide with that route's param matching.
router.get("/question-template", downloadQuestionTemplate);

router.get("/subjects/:subjectId/questions", listQuestions);
router.post("/subjects/:subjectId/questions", createQuestion);
router.post("/subjects/:subjectId/questions/import", adminUploadLimiter, upload.single("file"), importQuestions);
router.get("/questions/:questionId", getQuestion);
router.put("/questions/:questionId", updateQuestion);
router.delete("/questions/:questionId", deleteQuestion);

router.get("/sessions", listSessions);
router.get("/sessions/:sessionId", getSession);
router.get("/sessions/:sessionId/result", getSessionResult);
router.get("/sessions/:sessionId/answer-sheet", getSessionAnswerSheet);

router.get("/results/export.csv", exportResultsCsv);
router.get("/results/export.xlsx", exportResultsXlsx);
router.get("/results", listResults);

router.get("/proctoring/events/export.csv", exportProctoringEventsCsv);
router.get("/proctoring/events/export.xlsx", exportProctoringEventsXlsx);
router.get("/proctoring/events", listProctoringEvents);
router.post("/proctoring/event-summaries", summarizeMonitoringEvents);
router.patch("/proctoring/events/:eventId/review", reviewProctoringEvent);

router.get("/audit-logs", listAuditLogs);

// Captured Images — the automatic System Check check-in screenshots
// (candidate, exam, timestamp) captured by the student portal; see
// screenshot.controller.js. The image route streams the JPEG bytes
// straight out of the private Storage bucket rather than a signed URL.
router.get("/system-check-screenshots", listCheckInScreenshots);
router.get("/system-check-screenshots/:id/image", getCheckInScreenshotImage);

router.get("/mock-video", getMockVideo);
router.post("/mock-video", adminUploadLimiter, upload.videoUpload.single("video"), uploadMockVideo);
router.put("/mock-video/details", updateMockVideoDetails);
router.delete("/mock-video", deleteMockVideo);

// Exam branding (name + logo) — shown across the entire student portal
// (header, footer, login page, exam-taking header) via the public
// GET /api/exam/branding (see exam.routes.js). Every authenticated
// admin can view and change it.
router.get("/branding", getBranding);
router.put("/branding", updateBrandingName);
router.post("/branding/logo", adminUploadLimiter, upload.single("logo"), uploadBrandingLogo);

// Exam settings — these toggles actually change live student exam
// behavior (see settings.controller.js), not just this dashboard. Every
// authenticated admin can view and change them.
router.get("/settings", getSettings);
router.put("/settings", updateSettings);

// Proctoring rules shown to students on the Exam Proctoring & Rules
// page — what every student sees. Every authenticated admin can view,
// add, edit, reorder and delete. Student portal reads the active ones
// via GET /api/exam/rules (see exam.routes.js).
router.get("/rules", getRules);
router.post("/rules", createRule);
router.put("/rules/:ruleId", updateRule);
router.delete("/rules/:ruleId", deleteRule);

// Admin user management — every authenticated admin can manage admin
// accounts. There is a single role ("admin"); see admin.controller.js.
router.get("/users", listAdminUsers);
router.post("/users", createAdminUser);
router.put("/users/:adminId", updateAdminUser);
router.patch("/users/:adminId/status", updateAdminUserStatus);

module.exports = router;
