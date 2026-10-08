const express = require("express");
const studentAuth = require("../middleware/studentAuth");
const { sessionLimiter } = require("../middleware/rateLimiters");

const {
    startSession,
    submitExam
} = require("../controllers/session.controller");

const router = express.Router();

// Start (or resume) the authenticated student's session. Resuming always
// returns the student's existing in-progress session (whatever exam it
// belongs to); creating a new one requires the server-side preflight
// (System Check + check-in photo + rules acceptance) to be on record —
// see controllers/preflight.controller.js.
router.post("/start", studentAuth, sessionLimiter, startSession);

router.post("/submit", studentAuth, sessionLimiter, submitExam);

// The old admin result endpoint (static-API-key protected) has moved to
// GET /api/admin/sessions/:sessionId/result under proper JWT+role auth
// — see admin.routes.js / admin.controller.js.

module.exports = router;
