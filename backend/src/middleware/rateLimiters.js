const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// Per-identity limiters for the authenticated student/admin endpoints.
// Keyed by the authenticated candidate/admin id (these always run AFTER
// studentAuth/adminJwtAuth), never by IP alone — an entire exam hall can
// legitimately share one public IP. Limits sit well above real exam
// traffic (one answer per question, presence pings every 10s) and only
// cap scripted abuse.

const studentKey = (req) => req.student?.candidateId || ipKeyGenerator(req.ip);
const adminKey = (req) => req.admin?.id || ipKeyGenerator(req.ip);

function limiter({ windowMs, limit, keyGenerator, message }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
        message: { success: false, message }
    });
}

// Start/resume + submit. The exam page calls start on every mount and the
// waiting room polls it every few seconds before the scheduled start.
const sessionLimiter = limiter({
    windowMs: 60 * 1000,
    limit: 40,
    keyGenerator: studentKey,
    message: "Too many exam session requests. Please wait a moment and try again."
});

// One save per question (Next click or timer expiry), plus 409 re-syncs.
const answerLimiter = limiter({
    windowMs: 60 * 1000,
    limit: 60,
    keyGenerator: studentKey,
    message: "Too many answer submissions. Please wait a moment and try again."
});

// Check-in photo upload (retried at most a few times per attempt).
const screenshotLimiter = limiter({
    windowMs: 10 * 60 * 1000,
    limit: 15,
    keyGenerator: studentKey,
    message: "Too many photo uploads. Please wait a few minutes and try again."
});

// System-check completion / rules acceptance.
const preflightLimiter = limiter({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    keyGenerator: studentKey,
    message: "Too many check-in requests. Please wait a few minutes and try again."
});

// Every other authenticated student read (settings, info, current
// question, presence pings, rules, video, result).
const studentReadLimiter = limiter({
    windowMs: 60 * 1000,
    limit: 120,
    keyGenerator: studentKey,
    message: "Too many requests. Please slow down."
});

// Admin mock-video / logo / question-sheet uploads (up to 200MB each).
const adminUploadLimiter = limiter({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    keyGenerator: adminKey,
    message: "Too many uploads. Please try again later."
});

module.exports = {
    sessionLimiter,
    answerLimiter,
    screenshotLimiter,
    preflightLimiter,
    studentReadLimiter,
    adminUploadLimiter
};
