const supabase = require("../config/examSupabase");
const { getExamSettings, SESSION_FORBIDDEN_BODY } = require("./_examShared");
const { isUuid } = require("../utils/validation");


// =====================================================
// ALLOWED PROCTORING EVENTS
// =====================================================

const ALLOWED_EVENTS = [
    "MULTIPLE_FACE",
    "NO_FACE",
    "CAMERA_DISABLED",
    "MICROPHONE_DISABLED",
    "TAB_SWITCH",
    "WINDOW_BLUR",
    "FULLSCREEN_EXIT",
    "RIGHT_CLICK",
    "COPY_PASTE",
    "NETWORK_DISCONNECT",
    "NETWORK_RECONNECT",
    "EXAM_LEFT"
];


// =====================================================
// CAPTURE ONLY
// =====================================================
//
// Violations are recorded, never limited: there is no warning cap and no
// proctoring event ever blocks an attempt. Every event is stored in
// exam_events for the admin Violations page, and
// exam_sessions.proctoring_warning_count is kept as the attempt's running
// violation total (informational events are stored but not counted).

const MAX_EVENT_MESSAGE_LENGTH = 500;


// =====================================================
// EVENTS THAT ARE WARNINGS DURING EXAM
// =====================================================

const DURING_EXAM_WARNING_EVENTS = [
    "MULTIPLE_FACE",
    "NO_FACE",
    "CAMERA_DISABLED",
    "MICROPHONE_DISABLED",
    "TAB_SWITCH",
    "WINDOW_BLUR",
    "FULLSCREEN_EXIT",
    "RIGHT_CLICK",
    "EXAM_LEFT"
];

// NETWORK_DISCONNECT/NETWORK_RECONNECT are informational only — a flaky
// connection isn't cheating, so they're recorded (visible to admins in
// Violations/Monitoring) but never counted as violations.
// COPY_PASTE is informational too: the exam page already blocks the
// copy/cut/paste itself, so a reflexive Ctrl+C is logged for the admin
// without costing the student one of their three warnings.

// Maps each event type to the exam_settings flag that must be true for
// it to mean anything — e.g. a CAMERA_DISABLED report is meaningless (and
// must not be recorded as a violation) once an admin has switched camera
// off as a requirement. This is what makes an admin's Exam Settings
// toggle actually change enforcement, not just this dashboard's own
// appearance. RIGHT_CLICK and EXAM_LEFT (the student navigating away from
// the exam page — back button, new URL, closing the tab; see ExamPage.jsx)
// have no dedicated setting — both are governed only by the master
// proctoringEnabled switch below.
const EVENT_REQUIREMENT_SETTING = {
    MULTIPLE_FACE: "faceDetectionEnabled",
    NO_FACE: "faceDetectionEnabled",
    CAMERA_DISABLED: "cameraRequired",
    MICROPHONE_DISABLED: "microphoneRequired",
    FULLSCREEN_EXIT: "fullscreenRequired",
    TAB_SWITCH: "tabSwitchMonitoringEnabled",
    WINDOW_BLUR: "tabSwitchMonitoringEnabled",
    NETWORK_DISCONNECT: "networkMonitoringEnabled",
    NETWORK_RECONNECT: "networkMonitoringEnabled"
};


// =====================================================
// RECORD PROCTORING EVENT
// =====================================================

const recordEvent = async (req, res) => {
    try {
        const { sessionId, eventType, eventMessage, clientEventId, occurredAt } = req.body;
        const { candidateId, loginSessionId } = req.student;
        if (!isUuid(sessionId) || !ALLOWED_EVENTS.includes(eventType)) {
            return res.status(400).json({ success: false, message: "Valid session ID and event type are required" });
        }
        if ((clientEventId != null || occurredAt != null) &&
            (!isUuid(clientEventId) || typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt)))) {
            return res.status(400).json({ success: false, message: "Invalid event identity or occurrence time" });
        }
        const { data: session, error } = await supabase.from("exam_sessions")
            .select("id, candidate_id, status").eq("id", sessionId).maybeSingle();
        if (error) throw error;
        if (!session) return res.status(404).json({ success: false, message: "Exam session not found" });
        if (session.candidate_id !== candidateId) return res.status(403).json(SESSION_FORBIDDEN_BODY);
        const settings = await getExamSettings();
        if (!settings.proctoringEnabled || (EVENT_REQUIREMENT_SETTING[eventType] && !settings[EVENT_REQUIREMENT_SETTING[eventType]])) {
            return res.json({ success: true, recorded: false, blocked: false });
        }
        const isViolation = DURING_EXAM_WARNING_EVENTS.includes(eventType);
        const { data: result, error: rpcError } = await supabase.rpc("record_exam_event", {
            p_session_id: sessionId, p_candidate_id: candidateId, p_login_session_id: loginSessionId,
            p_client_event_id: clientEventId || null, p_event_type: eventType,
            p_event_message: typeof eventMessage === "string" ? eventMessage.trim().slice(0, MAX_EVENT_MESSAGE_LENGTH) : null,
            p_occurred_at: occurredAt || null, p_is_violation: isViolation
        });
        if (rpcError) throw rpcError;
        if (result?.code) {
            const status = result.code === "ACTIVE_SESSION_REQUIRED" ? 409 : result.code === "NOT_FOUND" ? 404
                : result.code === "FORBIDDEN" || result.code === "NOT_IN_PROGRESS" ? 403 : 400;
            return res.status(status).json({ success: false, code: result.code, status: result.status,
                message: result.code === "NOT_IN_PROGRESS" ? "The event occurred after this examination ended." : "Unable to record this event." });
        }
        return res.json(result);
    } catch (error) {
        console.error("[proctoring] atomic event save failed:", error.message);
        return res.status(503).json({ success: false, message: "Unable to save the monitoring event. It will be retried. Verify migration 020 is applied." });
    }
};
module.exports = { recordEvent };
