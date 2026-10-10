const express = require("express");
const studentAuth = require("../middleware/studentAuth");

const {
    getCurrentQuestion,
    getExamInfo,
    getSettings,
    postPresence,
    getMyResult
} = require("../controllers/exam.controller");

// Same handler the admin dashboard's mock-video panel reads from
// (GET /api/admin/mock-video) — it doesn't touch req.admin, so it's
// safe to reuse verbatim behind studentAuth instead of adminJwtAuth.
// This is what the Exam Proctoring Rules page (src/pages/
// ExamProctoringRulesPage.jsx) fetches to play whatever video the admin
// most recently uploaded, instead of a hardcoded file.
const {
    getMockVideo
} = require("../controllers/mockVideo.controller");

// The active proctoring rules the admin configured (Admin > Proctoring
// Rules). Read-only for students; returns the bundled-default-less empty
// list if the rules table hasn't been migrated yet, so the student page
// falls back to its own bundled defaults rather than erroring.
const {
    getPublicRules
} = require("../controllers/rules.controller");

// The exam name + logo shown across the entire student portal, admin-
// controlled via the Exam Branding page (Admin > Settings > Exam
// Branding, PUT/POST /api/admin/branding[/logo]). Same handler
// GET /api/admin/branding reads from.
const {
    getBranding
} = require("../controllers/branding.controller");

// Automatic, no-click check-in screenshot captured the moment System
// Check passes — see screenshot.controller.js for why this is keyed by
// (candidate, exam) rather than a session, which doesn't exist yet at
// this point in the flow.
const {
    screenshotUpload,
    uploadScreenshot
} = require("../controllers/screenshot.controller");

// Server-side record of System Check / rules acceptance — what
// POST /api/exam/session/start checks before creating a session, so the
// UI flow can't be bypassed by calling the API directly.
const {
    completeSystemCheck,
    acceptRules
} = require("../controllers/preflight.controller");

const {
    getNavigation,
    navigateQuestion,
    updateQuestionState,
    updateAnswer
} = require("../controllers/navigation.controller");

const {
    studentReadLimiter,
    screenshotLimiter,
    preflightLimiter
} = require("../middleware/rateLimiters");

const router = express.Router();

router.get("/current-question", studentAuth, studentReadLimiter, getCurrentQuestion);
router.get("/info", studentAuth, studentReadLimiter, getExamInfo);
router.get("/mock-video", studentAuth, studentReadLimiter, getMockVideo);
router.get("/settings", studentAuth, studentReadLimiter, getSettings);
router.get("/rules", studentAuth, studentReadLimiter, getPublicRules);
router.get("/result", studentAuth, studentReadLimiter, getMyResult);
// Intentionally NOT behind studentAuth — the Landing/login page needs
// the exam name and logo before any student is authenticated.
router.get("/branding", getBranding);
router.post("/presence", studentAuth, studentReadLimiter, postPresence);

// Rate limit runs before multer so a flood of uploads is rejected before
// any file is buffered into memory.
router.post("/system-check/screenshot", studentAuth, screenshotLimiter, screenshotUpload.single("screenshot"), uploadScreenshot);
router.post("/preflight/system-check", studentAuth, preflightLimiter, completeSystemCheck);
router.post("/preflight/rules-accepted", studentAuth, preflightLimiter, acceptRules);
router.get("/navigation", studentAuth, studentReadLimiter, getNavigation);
router.post("/navigation/question", studentAuth, studentReadLimiter, navigateQuestion);
router.patch("/navigation/state", studentAuth, studentReadLimiter, updateQuestionState);
router.patch("/navigation/answer", studentAuth, studentReadLimiter, updateAnswer);

module.exports = router;
