const supabase = require("../config/examSupabase");
const {
    getActiveExamForStudent,
    getExamById,
    getInProgressSession,
    recordPresence,
    getExamTiming,
    computeTimingStatus,
    scoreAndSubmitSession,
    initializeAttempt,
    attemptTiming,
    attemptRpcError
} = require("./_examShared");
const { checkPreflightForSessionStart } = require("./preflight.controller");
const { isUuid } = require("../utils/validation");

const NO_CLASS_CONTENT_MESSAGE = "No exam content is available yet for your class. Please check back later.";

// =====================================================
// START (OR RESUME) EXAM SESSION
//
// Get-or-create against the (candidate_id, exam_id) unique constraint —
// this is what makes it impossible for a student to end up with two
// active sessions for the same exam, and it's also the refresh-recovery
// path: calling this again on an in-progress session just returns where
// the student currently is, it never resets progress.
// =====================================================

// Shared tail of startSession for both a resumed and a newly created
// session. Everything here is derived from the session's OWN exam
// (session.exam_id), never from whichever exam is currently active.
async function respondWithSession(res, { session, exam, student }) {
    if (session.status !== "IN_PROGRESS") return res.status(403).json({
        success: false, status: session.status,
        message: session.status === "SUBMITTED" ? "This exam has already been submitted" : "This exam session is not in progress"
    });
    session = await initializeAttempt(session, student);
    if (Date.now() >= new Date(session.deadline_at).getTime() && await scoreAndSubmitSession(session)) {
        return res.status(403).json({ success: false, status: "SUBMITTED",
            message: "The examination time has ended. Your saved answers have been submitted automatically." });
    }
    // Resume touches activity without resetting the persisted position/timers.
    const { error: activityError } = await supabase.from("exam_sessions")
        .update({ last_activity_at: new Date().toISOString() }).eq("id", session.id).eq("status", "IN_PROGRESS");
    if (activityError) throw activityError;
    await recordPresence(session.candidate_id, "IN_EXAM");
    try {
        const { error } = await supabase.from("system_check_screenshots")
            .update({ session_id: session.id }).eq("candidate_id", session.candidate_id)
            .eq("exam_id", session.exam_id).is("session_id", null);
        if (error) throw error;
    } catch (error) { console.warn("[startSession] unable to link check-in screenshot:", error.message); }
    const timing = attemptTiming(session);
    return res.json({
        success: true,
        session: { id: session.id, status: session.status,
            currentSubjectIndex: session.current_subject_index,
            currentQuestionIndex: session.current_question_index,
            currentPosition: session.current_position, totalQuestions: session.total_questions,
            startedAt: session.started_at, deadlineAt: session.deadline_at,
            remainingSeconds: timing.remainingSeconds },
        exam: { id: exam.id, examCode: exam.exam_code, examName: exam.exam_name,
            secondsPerQuestion: session.seconds_per_question, totalQuestions: session.total_questions },
        ...timing
    });
}
const startSession = async (req, res) => {
    try {
        const { candidateId } = req.student;

        // An in-progress session always wins over whatever exam is active
        // right now: once a session exists, session.exam_id is the only
        // source of truth for this student's exam. Without this, an admin
        // activating Exam B while a student is mid-way through Exam A
        // would make the student's next refresh create a brand-new Exam B
        // session.
        const inProgress = await getInProgressSession(candidateId);
        if (inProgress) {
            const sessionExam = await getExamById(inProgress.exam_id);
            if (!sessionExam) {
                console.error("[startSession] in-progress session references a missing exam:", inProgress.id);
                return res.status(500).json({ success: false, message: "Unable to resume your exam session" });
            }
            return await respondWithSession(res, { session: inProgress, exam: sessionExam, student: req.student });
        }

        const { exam, classRow, code } = await getActiveExamForStudent(req.student.studentClass);
        if (code === "NO_ACTIVE_EXAM") {
            return res.status(404).json({
                success: false,
                message: "No active exam is configured"
            });
        }
        if (code === "NO_CLASS_CONTENT") {
            return res.status(404).json({
                success: false,
                message: NO_CLASS_CONTENT_MESSAGE
            });
        }

        // Admin-scheduled waiting room: a student may log in, run the
        // system check, watch the proctoring rules video and reach this
        // call at any time before the scheduled start — but the actual
        // exam session (and its timers) must not be created until the
        // real, server-clock start instant has passed. Nothing is
        // written here while waiting, so this is safe to poll repeatedly
        // with zero side effects; the frontend's waiting-room screen does
        // exactly that. An exam with no exam_start_at configured
        // (timing.status === "UNSCHEDULED") skips this entirely — that is
        // today's unchanged behavior.
        const timing = await getExamTiming(exam.id);
        const timingStatus = computeTimingStatus(timing);

        if (timingStatus.status === "SCHEDULED") {
            return res.status(200).json({
                success: true,
                waiting: true,
                serverTime: new Date().toISOString(),
                examStartAt: timing.examStartAt,
                secondsUntilStart: timingStatus.secondsUntilStart
            });
        }

        if (timingStatus.status === "COMPLETED") {
            return res.status(403).json({ success: false, status: "SUBMITTED", message: "The scheduled examination window has ended." });
        }

        const { data: existing, error: existingError } = await supabase
            .from("exam_sessions")
            .select("*")
            .eq("candidate_id", candidateId)
            .eq("exam_id", exam.id)
            .maybeSingle();

        if (existingError) {
            console.error("[startSession] existing-session lookup error:", existingError);
            return res.status(500).json({
                success: false,
                message: "Unable to check existing exam session"
            });
        }

        let session = existing;

        if (!session) {
            // Server-enforced preflight: System Check + check-in photo +
            // rules acceptance must be on record before a session (and
            // its timers) can exist. A student calling this endpoint
            // directly, skipping the UI, gets 403 here.
            const preflightFailure = await checkPreflightForSessionStart(candidateId, exam.id);
            if (preflightFailure) {
                return res.status(preflightFailure.status).json(preflightFailure.body);
            }

            // One transaction creates the session and its question sequence
            // (019_attempt_integrity.sql). If initialization fails nothing
            // is kept, and a concurrent double-click reuses the winner's row.
            // seconds_per_question is snapshotted: later admin timer edits
            // never change an already-running attempt.
            const { data: started, error: startError } = await supabase.rpc("start_exam_attempt", {
                p_candidate_id: candidateId,
                p_login_session_id: req.student.loginSessionId,
                p_exam_id: exam.id,
                p_class_id: classRow.id,
                p_seconds_per_question: exam.seconds_per_question
            });
            if (startError) {
                console.error("[startSession] session creation error:", startError);
                return res.status(500).json({
                    success: false,
                    message: "Unable to create exam session"
                });
            }
            const startFailure = attemptRpcError(started);
            if (startFailure) {
                return res.status(startFailure.status).json({ success: false, code: startFailure.code,
                    message: startFailure.message, status: startFailure.attemptStatus });
            }
            session = started.session;
        }

        return await respondWithSession(res, { session, exam, student: req.student });

    } catch (error) {
        console.error("[startSession] error:", error);
        return res.status(error.status || 503).json({
            success: false,
            code: error.code,
            message: error.status ? error.message : "Unable to restore the examination. Please try again."
        });
    }
};


// =====================================================
// SUBMIT EXAM
//
// Locks the session and scores it server-side from exam_answers, which
// were already evaluated against questions.correct_option as each one
// was saved (see answer.controller.js). The frontend never sees the
// score here — it's stored for the admin/results pipeline only.
// =====================================================

const submitExam = async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!isUuid(sessionId)) return res.status(400).json({ success: false, message: "A valid session ID is required" });
        const { data, error } = await supabase.rpc("submit_exam_attempt", {
            p_session_id: sessionId, p_candidate_id: req.student.candidateId,
            p_login_session_id: req.student.loginSessionId
        });
        if (error) throw error;
        const failure = attemptRpcError(data);
        if (failure) return res.status(failure.status).json({ success: false, code: failure.code,
            message: failure.message, status: failure.attemptStatus });
        return res.json({ success: true, message: "Examination submitted successfully",
            status: data.status, submittedAt: data.submittedAt,
            attemptedCount: data.attemptedCount, totalQuestions: data.totalQuestions });
    } catch (error) {
        console.error("[submitExam] error:", error);
        return res.status(503).json({ success: false, message: "Unable to submit. Your saved answers are retained; please reconnect and retry." });
    }
};

module.exports = {
    startSession,
    submitExam
};
