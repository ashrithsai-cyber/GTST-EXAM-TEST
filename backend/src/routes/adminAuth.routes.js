const express = require("express");
const rateLimit = require("express-rate-limit");
const adminJwtAuth = require("../middleware/adminJwtAuth");
const { login, me } = require("../controllers/adminAuth.controller");

const router = express.Router();

// Slows brute-force email/password guessing without locking out a
// legitimate admin who mistypes a password a couple of times.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many login attempts. Please try again later." }
});

router.post("/login", loginLimiter, login);
router.get("/me", adminJwtAuth, me);

module.exports = router;
