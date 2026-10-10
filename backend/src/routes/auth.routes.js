const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const {
    login,
    heartbeat,
    logout
} = require("../controllers/auth.controller");
const studentAuth = require("../middleware/studentAuth");
const { sessionLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// Keyed by IP + registrationId (not IP alone) so a brute-force attempt
// against one specific hall ticket is throttled without penalizing an
// entire exam-hall/school network sharing one IP as different students
// log in normally.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.registrationId ?? "").trim().toLowerCase().slice(0, 64)}`,
    message: { success: false, message: "Too many login attempts. Please try again later." }
});

router.post("/login", loginLimiter, login);
router.post("/heartbeat", studentAuth, sessionLimiter, heartbeat);
router.post("/logout", sessionLimiter, logout);

module.exports = router;
