// quiet: dotenv 17 otherwise prints a promotional tip on every start.
// In production the host usually injects real env vars and no .env exists.
require("dotenv").config({ quiet: true });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");

const examRoutes = require("./routes/exam.routes");
const answerRoutes = require("./routes/answer.routes");
const sessionRoutes = require("./routes/session.routes");
const authRoutes = require("./routes/auth.routes");
const proctoringRoutes = require("./routes/proctoring.routes");
const adminAuthRoutes = require("./routes/adminAuth.routes");
const adminRoutes = require("./routes/admin.routes");

// Refuse to start with missing, weak or shared token secrets. Equal
// secrets would let a token minted for one audience verify for the other,
// so student and admin secrets must differ. Values are never logged.
(function assertJwtSecrets() {
    const problems = [];
    for (const name of ["STUDENT_JWT_SECRET", "ADMIN_JWT_SECRET"]) {
        const value = process.env[name];
        if (!value) problems.push(`${name} is not set`);
        else if (value.length < 32) problems.push(`${name} must be at least 32 characters`);
    }
    if (process.env.STUDENT_JWT_SECRET && process.env.STUDENT_JWT_SECRET === process.env.ADMIN_JWT_SECRET) {
        problems.push("STUDENT_JWT_SECRET and ADMIN_JWT_SECRET must be different");
    }
    if (problems.length) {
        console.error(`Refusing to start: ${problems.join("; ")}. See backend/.env.example.`);
        process.exit(1);
    }
})();

const app = express();

const PORT = process.env.PORT || 5000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Keep clock-related JWT/Supabase failures diagnosable without exposing
// secrets. Supabase rejects tokens whose iat is ahead of its clock.
console.log(`Backend clock: ${new Date().toISOString()}`);

// Behind a reverse proxy / load balancer (Nginx, Render, Railway, etc.)
// req.ip is the proxy's address unless Express is told how many proxy
// hops to trust — without this every student would share one rate-limit
// bucket. Set TRUST_PROXY to the number of proxies in front of the app.
if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set("trust proxy", Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// Security
app.use(helmet());


// CORS
// Allows the student portal's Vite dev server (port 5173) whether it's
// opened via localhost or via the machine's LAN IP (e.g. testing from a
// phone on the same network), plus any origin explicitly listed in
// ADMIN_ALLOWED_ORIGINS for the separate Exam Admin Dashboard, plus any
// origin explicitly listed in STUDENT_ALLOWED_ORIGINS for the student
// portal's real deployed domain(s) — never a blanket wildcard. The
// LAN-IP branch is restricted to actual private address ranges (RFC
// 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) rather than any IPv4
// literal, so it can't be satisfied by an arbitrary public IP.
//
// STUDENT_ALLOWED_ORIGINS exists because ALLOWED_ORIGIN_PATTERN only
// ever matches port 5173 on localhost/a private LAN IP — i.e. only dev.
// Without it, once this backend and the student portal are deployed to
// real public hostnames, every request from the deployed student portal
// would be rejected here (CORS has no concept of "same app, different
// environment"). Empty/unset by default, so this is purely additive: it
// changes nothing about today's dev behavior until it's actually set.
const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|192\.168(\.\d{1,3}){2}):5173$/;

const ADMIN_ALLOWED_ORIGINS = (process.env.ADMIN_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const STUDENT_ALLOWED_ORIGINS = (process.env.STUDENT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (
            !origin ||
            // The localhost/LAN dev-server pattern is development-only; a
            // production deployment lists its real origins explicitly.
            (!IS_PRODUCTION && ALLOWED_ORIGIN_PATTERN.test(origin)) ||
            ADMIN_ALLOWED_ORIGINS.includes(origin) ||
            STUDENT_ALLOWED_ORIGINS.includes(origin)
        ) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    }
}));

// JSON parser — every JSON body in this API is small; uploads use multer.
app.use(express.json({ limit: "100kb" }));

// Exam routes
app.use("/api/exam", examRoutes);
app.use("/api/exam", answerRoutes);
app.use("/api/exam/session", sessionRoutes);
app.use("/api/exam/auth", authRoutes);
app.use("/api/exam/proctoring", proctoringRoutes);

// Admin routes — JWT-based, entirely separate auth system from the
// student side. Only ever touch examSupabase, never registrationSupabase.
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin", adminRoutes);

// Home route
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "GTST+ 2026 Exam Portal Backend is running"
    });
});

// Health check
app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        server: "online",
        serverTime: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found"
    });
});

// Global error handler — must be registered last. Without this, an error
// passed to next(err) anywhere (e.g. a rejected CORS origin) falls through
// to Express's default handler, which can crash the whole process instead
// of just responding to the one bad request.
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    if (err.message === "Not allowed by CORS") {
        return res.status(403).json({
            success: false,
            message: "Origin not allowed"
        });
    }

    // Upload rejected by multer before reaching a controller (file over
    // the size limit, unexpected field name, ...) — a client error, not a
    // server one.
    if (err instanceof multer.MulterError) {
        return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
            success: false,
            message: err.code === "LIMIT_FILE_SIZE" ? "The uploaded file is too large" : "Invalid file upload"
        });
    }

    // Malformed JSON body / body over express.json()'s size limit.
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
        return res.status(err.status || 400).json({
            success: false,
            message: "Invalid request body"
        });
    }

    // Full detail stays in the server log; the client only ever gets a
    // generic message (no stack traces, SQL or config details).
    console.error("Unhandled error:", err);
    res.status(500).json({
        success: false,
        message: "Server error"
    });
});

// Start server (only when run directly — the security test suite in
// backend/test imports the app without binding a port).
if (require.main === module) {
    if (process.env.NODE_ENV !== "test") {
        require("./utils/attemptExpiry").startAttemptExpiryWorker();
    }
    app.listen(PORT, () => {
        console.log(`GTST+ Exam Portal backend listening on port ${PORT}`);
    });
}

module.exports = app;
