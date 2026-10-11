const supabase = require("../config/examSupabase");
const { getStudentExamContext, getExamSettings } = require("./_examShared");

// =====================================================
// SERVER-SIDE PREFLIGHT (System Check -> Proctoring Rules)
//
// The student UI flow is Login -> Confirm -> System Check -> Proctoring
// Rules -> Exam. The frontend's own "checks passed" flags live in the
// browser and can be forged, so the backend keeps its own record in
// exam_preflight (014_preflight_results_hardening.sql) and
// POST /api/exam/session/start refuses to create a session until:
//
//   1. System Check was completed (every admin-required check reported
//      as passing) — POST /api/exam/preflight/system-check
//   2. a check-in screenshot actually exists in private storage, when the
//      camera is required (written by screenshot.controller.js — the
//      one part of the check the server can verify from real bytes)
//   3. the proctoring rules were accepted AFTER that system check —
//      POST /api/exam/preflight/rules-accepted
//
// all within PREFLIGHT_MAX_AGE_MINUTES. Everything is keyed by the
// authenticated candidate + the exam a new session would be created for;
// nothing identifying is taken from the request body.
// =====================================================

const PREFLIGHT_MAX_AGE_MINUTES = (() => {
    const value = Number(process.env.PREFLIGHT_MAX_AGE_MINUTES);
    return Number.isFinite(value) && value > 0 ? value : 720;
})();

const PREFLIGHT_REQUIRED_MESSAGE = "System check must be completed before starting the exam.";
const RULES_REQUIRED_MESSAGE = "The proctoring rules must be accepted before starting the exam.";

class PreflightUnavailableError extends Error {}

function isFresh(timestamp) {
    if (!timestamp) return false;
    return Date.now() - new Date(timestamp).getTime() <= PREFLIGHT_MAX_AGE_MINUTES * 60000;
}

async function getPreflightRow(candidateId, examId) {
    const { data, error } = await supabase
        .from("exam_preflight")
        .select("*")
        .eq("candidate_id", candidateId)
        .eq("exam_id", examId)
        .maybeSingle();

    if (error) {
        // Fail closed: without this table the server cannot prove the
        // student completed System Check, so no new session is created.
        console.error("[preflight] exam_preflight unavailable (has backend/sql/014_preflight_results_hardening.sql been run?):", error.message || error);
        throw new PreflightUnavailableError("exam_preflight unavailable");
    }
    return data;
}

async function getScreenshotCapturedAt(candidateId, examId) {
    const { data, error } = await supabase
        .from("system_check_screenshots")
        .select("captured_at")
        .eq("candidate_id", candidateId)
        .eq("exam_id", examId)
        .maybeSingle();

    if (error) throw error;
    return data?.captured_at || null;
}

async function upsertPreflight(candidateId, examId, fields) {
    const { error } = await supabase
        .from("exam_preflight")
        .upsert(
            { candidate_id: candidateId, exam_id: examId, ...fields, updated_at: new Date().toISOString() },
            { onConflict: "candidate_id,exam_id" }
        );

    if (error) {
        console.error("[preflight] exam_preflight write failed (has backend/sql/014_preflight_results_hardening.sql been run?):", error.message || error);
        throw new PreflightUnavailableError("exam_preflight unavailable");
    }
}

// Stamps the check-in screenshot time on the preflight row. Called by
// screenshot.controller.js after a successful upload; never throws — the
// authoritative check at session start reads system_check_screenshots
// directly, this column is just an audit convenience.
async function recordCheckInScreenshot(candidateId, examId, capturedAt) {
    try {
        await upsertPreflight(candidateId, examId, { check_in_screenshot_at: capturedAt });
    } catch {
        // Already logged in upsertPreflight.
    }
}

// Resolves the exam this check-in is for: the student's in-progress
// session's exam if they have one (e.g. re-checking in on another device
// after an admin switched the active exam), otherwise the exam a new
// session would be created for. Returns a ready error response tuple when
// there's nothing to check in to.
async function resolvePreflightExam(req) {
    const { exam, code } = await getStudentExamContext(req.student.candidateId, req.student.studentClass);
    if (code === "NO_ACTIVE_EXAM") return { error: [404, "No active exam is configured"] };
    if (code === "NO_CLASS_CONTENT") return { error: [404, "No exam content is available yet for your class. Please check back later."] };
    return { exam };
}

function unavailableResponse(res) {
    return res.status(503).json({
        success: false,
        message: "Exam check-in is temporarily unavailable. Please contact the exam administrator."
    });
}


// =====================================================
// POST /api/exam/preflight/system-check
// Body: { camera, microphone, fullscreen, face } booleans
// =====================================================

const completeSystemCheck = async (req, res) => {
    try {
        const { candidateId } = req.student;
        const { exam, error } = await resolvePreflightExam(req);
        if (error) return res.status(error[0]).json({ success: false, message: error[1] });

        const checks = {
            camera: req.body?.camera === true,
            microphone: req.body?.microphone === true,
            fullscreen: req.body?.fullscreen === true,
            face: req.body?.face === true
        };

        const settings = await getExamSettings();
        const failed = [];
        if (settings.cameraRequired && !checks.camera) failed.push("camera");
        if (settings.microphoneRequired && !checks.microphone) failed.push("microphone");
        if (settings.fullscreenRequired && !checks.fullscreen) failed.push("fullscreen");
        if (settings.faceDetectionEnabled && !checks.face) failed.push("face");

        if (failed.length) {
            return res.status(400).json({
                success: false,
                code: "SYSTEM_CHECK_INCOMPLETE",
                message: `System check is incomplete: ${failed.join(", ")}.`,
                failed
            });
        }

        let screenshotAt = null;
        if (settings.photoCaptureEnabled) {
            screenshotAt = await getScreenshotCapturedAt(candidateId, exam.id);
            if (!isFresh(screenshotAt)) {
                return res.status(400).json({
                    success: false,
                    code: "CHECK_IN_PHOTO_REQUIRED",
                    message: "Your check-in photo has not been saved. Please accept the terms again to retake it."
                });
            }
        }

        // A fresh system check always invalidates an earlier rules
        // acceptance — the rules must be accepted after THIS check.
        await upsertPreflight(candidateId, exam.id, {
            camera_check: checks.camera,
            microphone_check: checks.microphone,
            fullscreen_check: checks.fullscreen,
            face_check: checks.face,
            check_in_screenshot_at: screenshotAt,
            system_check_completed_at: new Date().toISOString(),
            rules_accepted_at: null
        });

        return res.json({ success: true, systemCheckCompleted: true });
    } catch (error) {
        if (error instanceof PreflightUnavailableError) return unavailableResponse(res);
        console.error("[completeSystemCheck] error:", error);
        return res.status(500).json({ success: false, message: "Unable to record the system check. Please try again." });
    }
};


// =====================================================
// POST /api/exam/preflight/rules-accepted
// =====================================================

const acceptRules = async (req, res) => {
    try {
        const { candidateId } = req.student;
        const { exam, error } = await resolvePreflightExam(req);
        if (error) return res.status(error[0]).json({ success: false, message: error[1] });

        const row = await getPreflightRow(candidateId, exam.id);
        if (!row || !isFresh(row.system_check_completed_at)) {
            return res.status(403).json({
                success: false,
                code: "PREFLIGHT_REQUIRED",
                message: PREFLIGHT_REQUIRED_MESSAGE
            });
        }

        await upsertPreflight(candidateId, exam.id, { rules_accepted_at: new Date().toISOString() });

        return res.json({ success: true, rulesAccepted: true });
    } catch (error) {
        if (error instanceof PreflightUnavailableError) return unavailableResponse(res);
        console.error("[acceptRules] error:", error);
        return res.status(500).json({ success: false, message: "Unable to record rules acceptance. Please try again." });
    }
};


// =====================================================
// Session-start gate (used by session.controller.js)
//
// Returns null when the candidate may start `examId`, otherwise
// { status, body } for the caller to send. Only consulted when creating a
// NEW session; resuming an existing IN_PROGRESS session was already
// gated when it was created.
// =====================================================

async function checkPreflightForSessionStart(candidateId, examId) {
    let row;
    try {
        row = await getPreflightRow(candidateId, examId);
    } catch (error) {
        if (error instanceof PreflightUnavailableError) {
            return {
                status: 503,
                body: { success: false, message: "Exam check-in is temporarily unavailable. Please contact the exam administrator." }
            };
        }
        throw error;
    }

    if (!row || !isFresh(row.system_check_completed_at)) {
        return { status: 403, body: { success: false, code: "PREFLIGHT_REQUIRED", message: PREFLIGHT_REQUIRED_MESSAGE } };
    }

    if (
        !row.rules_accepted_at ||
        !isFresh(row.rules_accepted_at) ||
        new Date(row.rules_accepted_at).getTime() < new Date(row.system_check_completed_at).getTime()
    ) {
        return { status: 403, body: { success: false, code: "RULES_NOT_ACCEPTED", message: RULES_REQUIRED_MESSAGE } };
    }

    // Re-validated at start time, not just at system-check time: the
    // admin's requirement toggles are read fresh, and the photo must
    // still exist in storage metadata.
    const settings = await getExamSettings();
    const changed = [
        [settings.cameraRequired, row.camera_check],
        [settings.microphoneRequired, row.microphone_check],
        [settings.fullscreenRequired, row.fullscreen_check],
        [settings.faceDetectionEnabled, row.face_check]
    ].some(([required, passed]) => required && !passed);
    if (changed) return { status: 403, body: { success: false, code: "PREFLIGHT_REQUIRED",
        message: "Exam requirements changed. Please complete the system check again." } };
    if (settings.photoCaptureEnabled && !(await getScreenshotCapturedAt(candidateId, examId))) {
        return { status: 403, body: { success: false, code: "PREFLIGHT_REQUIRED", message: PREFLIGHT_REQUIRED_MESSAGE } };
    }

    return null;
}

module.exports = {
    completeSystemCheck,
    acceptRules,
    checkPreflightForSessionStart,
    recordCheckInScreenshot
};
