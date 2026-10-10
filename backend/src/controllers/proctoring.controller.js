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
// EVENTS THAT ARE WARNINGS BEFORE EXAM STARTS
// =====================================================
//
// IMPORTANT:
//
// MULTIPLE_FACE is checked even during PRE-EXAM.
//
// This means:
//     2 faces before Start Examination
//     -> counted as a violation
//
// But:
//     Fullscreen not entered
//     -> not counted
//
//     Tab switch before exam
//     -> not counted
//
//     Right click before exam
//     -> not counted
//
// NOTE (currently unreachable): the only frontend caller of
// POST /api/exam/proctoring/event is ExamPage.jsx's reportEvent, which is
// never mounted/called until after startSession has already flipped the
// session to IN_PROGRESS — see session.controller.js. So the session is
// always IN_PROGRESS in recordEvent() in practice today, and this
// PRE_EXAM_WARNING_EVENTS branch never actually runs. It's left in place
// (not dead code to delete) as the intended hook for a future pre-exam
// caller — e.g. face-detection during System Check
// (src/pages/SystemCheckPage.jsx) reporting MULTIPLE_FACE before the
// student even reaches Start Examination — but wiring that up is a
// product decision (when to fire, at what threshold) that hasn't been
// made yet, not something to add silently here.
// =====================================================

const PRE_EXAM_WARNING_EVENTS = [
    "MULTIPLE_FACE"
];


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

        const {
            sessionId,
            eventType,
            eventMessage
        } = req.body;

        const { candidateId } = req.student;


        // =================================================
        // VALIDATE REQUEST
        // =================================================

        if (
            !isUuid(sessionId) ||
            !eventType
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Session ID and event type are required"
            });
        }

        const safeEventMessage =
            typeof eventMessage === "string" && eventMessage.trim()
                ? eventMessage.trim().slice(0, MAX_EVENT_MESSAGE_LENGTH)
                : null;


        // =================================================
        // VALIDATE EVENT
        // =================================================

        if (
            !ALLOWED_EVENTS.includes(
                eventType
            )
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Invalid event type"
            });
        }


        // =================================================
        // GET SESSION
        //
        // Deliberately checked (existence + ownership) BEFORE the exam
        // settings gate below, even though a disabled-proctoring response
        // never records anything — ownership must be verified before ANY
        // response is returned for a sessionId, on principle: a request
        // referencing another candidate's session should 404 regardless
        // of feature-flag state, not just whenever proctoring happens to
        // be enabled. (Previously this ran after the settings gate, so
        // with proctoring disabled — as it is by default — a request
        // could reference any other candidate's sessionId and still get
        // back a 200; harmless in that specific state since nothing was
        // ever written or revealed, but not something to rely on staying
        // harmless as this function changes.)
        // =================================================

        const {
            data: session,
            error: sessionError
        } = await supabase
            .from("exam_sessions")
            .select(
                "id, status, proctoring_warning_count, candidate_id"
            )
            .eq(
                "id",
                sessionId
            )
            .maybeSingle();


        // =================================================
        // SESSION ERROR
        // =================================================

        if (sessionError) {

            console.error(
                "Session verification error:",
                sessionError
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify exam session"
            });
        }


        // =================================================
        // SESSION NOT FOUND / NOT OWNED BY THIS STUDENT
        // =================================================

        if (!session) {

            return res.status(404).json({
                success: false,
                message:
                    "Exam session not found"
            });
        }

        // Authenticated identity must own the session — one student can
        // never file events (or trigger a block) against another's.
        if (session.candidate_id !== candidateId) {
            return res.status(403).json(SESSION_FORBIDDEN_BODY);
        }


        // =================================================
        // EXAM SETTINGS — an admin-disabled category is not just
        // "not a warning", it's not recorded as a proctoring event at
        // all, so Violations/Monitoring never shows something the admin
        // explicitly turned off as noise.
        // =================================================

        const settings = await getExamSettings();

        if (!settings.proctoringEnabled) {
            return res.json({
                success: true,
                message: "Proctoring is disabled for this exam; event not recorded",
                recorded: false,
                blocked: false
            });
        }

        const requiredSetting = EVENT_REQUIREMENT_SETTING[eventType];
        if (requiredSetting && !settings[requiredSetting]) {
            return res.json({
                success: true,
                message: "This check is not required for this exam; event not recorded",
                recorded: false,
                blocked: false
            });
        }


        // =================================================
        // ALREADY SUBMITTED
        // =================================================

        if (
            session.status ===
            "SUBMITTED"
        ) {

            return res.status(403).json({
                success: false,
                message:
                    "Exam has already been submitted"
            });
        }


        // =================================================
        // ALREADY BLOCKED
        // =================================================

        if (
            session.status ===
            "BLOCKED"
        ) {

            return res.status(403).json({
                success: false,
                message:
                    "Examination has already been blocked",
                blocked: true
            });
        }


        // =================================================
        // RECORD THE VIOLATION (capture only — never blocks)
        // =================================================

        const isViolation = session.status === "IN_PROGRESS"
            ? DURING_EXAM_WARNING_EVENTS.includes(eventType)
            : PRE_EXAM_WARNING_EVENTS.includes(eventType);

        const { data: event, error: eventError } = await supabase
            .from("exam_events")
            .insert([{
                session_id: sessionId,
                event_type: eventType,
                event_message: safeEventMessage,
                warning_number: null
            }])
            .select()
            .single();

        if (eventError) {
            console.error("Event insert error:", eventError);
            return res.status(500).json({
                success: false,
                message: "Unable to record proctoring event"
            });
        }

        // Running violation total for the attempt. Conditional on the value
        // just read, so two simultaneous events can't overwrite each other;
        // re-read and retry when another event landed first.
        let violationCount = Number(session.proctoring_warning_count) || 0;
        if (isViolation) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const { data: updated, error: updateError } = await supabase
                    .from("exam_sessions")
                    .update({ proctoring_warning_count: violationCount + 1 })
                    .eq("id", sessionId)
                    .eq("proctoring_warning_count", violationCount)
                    .select("id");
                if (updateError) {
                    console.error("Violation count update error:", updateError);
                    break;
                }
                if (updated && updated.length > 0) {
                    violationCount += 1;
                    break;
                }
                const { data: fresh } = await supabase
                    .from("exam_sessions")
                    .select("proctoring_warning_count")
                    .eq("id", sessionId)
                    .maybeSingle();
                violationCount = Number(fresh?.proctoring_warning_count) || 0;
            }
        }

        return res.json({
            success: true,
            message: "Proctoring event recorded",
            recorded: true,
            violation: isViolation,
            violationCount,
            blocked: false,
            eventId: event.id
        });


    } catch (error) {

        console.error(
            "Proctoring controller error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                "Server error while recording the proctoring event"
        });
    }
};


// =====================================================
// EXPORT
// =====================================================

module.exports = {
    recordEvent
};