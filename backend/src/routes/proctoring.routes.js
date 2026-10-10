const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const studentAuth = require("../middleware/studentAuth");

const {
    recordEvent
} = require("../controllers/proctoring.controller");

const router = express.Router();

// Keyed per-candidate (not per-IP) since studentAuth has already run and
// many students legitimately share one exam-hall IP. Generous enough for
// real proctoring traffic (face-detection transitions, tab switches,
// blur/focus, network blips) but caps a script from spamming exam_events.
const proctoringEventLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.student?.candidateId || ipKeyGenerator(req.ip),
    message: { success: false, message: "Too many proctoring events reported. Please slow down." }
});

router.post("/event", studentAuth, proctoringEventLimiter, recordEvent);

module.exports = router;
