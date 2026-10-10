const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const supabase = require("../config/examSupabase");
const { isUuid } = require("./validation");

const SESSION_ACTIVE_BODY = {
    success: false,
    code: "SESSION_ACTIVE",
    message: "Your exam is already active on another device."
};
const SESSION_EXPIRED_BODY = {
    success: false,
    code: "SESSION_EXPIRED",
    message: "Your active session has expired or ended. Please log in again on your original device."
};

function readStudentToken(req, { allowExpired = false } = {}) {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) return null;
    const secret = process.env.STUDENT_JWT_SECRET;
    if (!secret) throw new Error("STUDENT_JWT_SECRET is not configured");
    try {
        const payload = jwt.verify(token, secret, { algorithms: ["HS256"], ignoreExpiration: allowExpired });
        if (payload.typ !== "student" || payload.adminId !== undefined ||
            !isUuid(payload.candidateId) || !isUuid(payload.loginSessionId) || !Number.isFinite(payload.exp)) return null;
        return payload;
    } catch {
        return null;
    }
}

function issueStudentToken({ candidateId, registrationId, studentClass, loginSessionId }) {
    const token = jwt.sign(
        { candidateId, registrationId, studentClass, loginSessionId, typ: "student" },
        process.env.STUDENT_JWT_SECRET,
        { algorithm: "HS256", expiresIn: process.env.STUDENT_JWT_EXPIRES_IN || "4h" }
    );
    return { token, expiresAt: new Date(jwt.decode(token).exp * 1000).toISOString() };
}

async function sessionRpc(name, args) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
        console.error(`[student session] ${name} failed:`, error.message || error);
        throw new Error("Unable to validate the active student session. Apply database migration 018_single_device_sessions.sql.");
    }
    return data;
}

async function acquireStudentSession(candidate, student, recoveryPayload) {
    const loginSessionId = recoveryPayload?.candidateId === candidate.id
        ? recoveryPayload.loginSessionId : crypto.randomUUID();
    const issued = issueStudentToken({
        candidateId: candidate.id,
        registrationId: student.registration_id,
        studentClass: student.student_class,
        loginSessionId
    });
    const result = await sessionRpc("acquire_student_login_session", {
        p_candidate_id: candidate.id,
        p_login_session_id: loginSessionId,
        p_token_expires_at: issued.expiresAt
    });
    return { ...result, ...issued, loginSessionId };
}

async function touchStudentSession(payload, tokenExpiresAt) {
    return sessionRpc("touch_student_login_session", {
        p_candidate_id: payload.candidateId,
        p_login_session_id: payload.loginSessionId,
        p_token_expires_at: tokenExpiresAt || new Date(payload.exp * 1000).toISOString()
    });
}

module.exports = {
    SESSION_ACTIVE_BODY,
    SESSION_EXPIRED_BODY,
    readStudentToken,
    issueStudentToken,
    acquireStudentSession,
    touchStudentSession,
    sessionRpc
};
