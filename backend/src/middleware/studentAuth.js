const { readStudentToken, touchStudentSession, SESSION_EXPIRED_BODY } = require("../utils/studentSessions");

// Verifies the JWT issued at login (auth.controller.js) and attaches the
// authenticated student's identity to the request. Every exam session /
// question / answer route requires this — it's what lets the backend
// enforce "a student may only touch their own session" instead of trusting
// whatever sessionId the client happens to send.
const studentAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || "";
        const [scheme, token] = authHeader.split(" ");

        if (scheme !== "Bearer" || !token) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }

        const secret = process.env.STUDENT_JWT_SECRET;
        if (!secret) {
            console.error("STUDENT_JWT_SECRET is not configured");
            return res.status(500).json({
                success: false,
                message: "Authentication is not configured"
            });
        }

        const payload = readStudentToken(req);
        // Stateless tokens issued before single-device control require
        // a fresh login, so they cannot bypass the database lease.
        if (!payload) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired session. Please log in again."
            });
        }

        const activeSession = await touchStudentSession(payload);
        if (!activeSession?.active) {
            return res.status(409).json(SESSION_EXPIRED_BODY);
        }

        req.student = {
            candidateId: payload.candidateId,
            registrationId: payload.registrationId,
            studentClass: payload.studentClass,
            loginSessionId: payload.loginSessionId,
            tokenExpiresAt: payload.exp,
            loginExpiresAt: activeSession.expiresAt,
            loginServerTime: activeSession.serverTime
        };

        next();
    } catch (error) {
        console.error("[studentAuth] active session validation failed:", error.message);
        return res.status(503).json({
            success: false,
            code: "SESSION_UNAVAILABLE",
            message: "Unable to verify your active session. Please retry shortly."
        });
    }
};

module.exports = studentAuth;
