const supabase = require("../config/examSupabase");
const {
    SESSION_FORBIDDEN_BODY, attemptRpcError, getAttemptQuestion,
    getAttemptSubjects, displayAttemptQuestion, attemptTiming
} = require("./_examShared");
const { isUuid } = require("../utils/validation");

// The database locks the device lease and attempt, validates the current
// question, saves its answer and advances its pointer in one transaction.
async function writeAnswer(req, res, advance) {
    try {
        const { sessionId, questionId, selectedOption } = req.body;
        if (!isUuid(sessionId) || !isUuid(questionId)) {
            return res.status(400).json({ success: false, message: "Valid session ID and question ID are required" });
        }
        if (selectedOption != null && !["A", "B", "C", "D"].includes(selectedOption)) {
            return res.status(400).json({ success: false, message: "Selected option must be A, B, C or D" });
        }
        const { data, error } = await supabase.rpc("save_exam_answer", {
            p_session_id: sessionId, p_candidate_id: req.student.candidateId,
            p_login_session_id: req.student.loginSessionId, p_question_id: questionId,
            p_selected_option: selectedOption ?? null, p_advance: advance
        });
        if (error) throw error;
        const failure = attemptRpcError(data);
        if (failure) return res.status(failure.status).json({ success: false, code: failure.code,
            message: failure.message, status: failure.attemptStatus });
        if (!advance && !data.examComplete) return res.json({ success: true,
            selectedOption: data.selectedOption, serverTime: data.serverTime, draftSaved: true });
        let nextQuestion = null;
        let timing = { serverTime: data.serverTime, remainingSeconds: 0 };
        if (!data.examComplete && data.session) {
            const [row, subjects] = await Promise.all([getAttemptQuestion(data.session), getAttemptSubjects(sessionId)]);
            nextQuestion = displayAttemptQuestion(row, subjects);
            timing = attemptTiming(data.session);
        }
        return res.json({
            success: true, message: data.autoSubmitted ? "Examination submitted successfully" : "Answer saved",
            timedOut: Boolean(data.timedOut), autoSubmitted: Boolean(data.autoSubmitted),
            status: data.status, submittedAt: data.submittedAt,
            sectionComplete: Boolean(data.sectionComplete), examComplete: Boolean(data.examComplete),
            nextSubjectIndex: data.nextSubjectIndex ?? null, nextQuestionIndex: data.nextQuestionIndex ?? null,
            sequenceNumber: nextQuestion?.sequenceNumber ?? null,
            totalQuestions: data.totalQuestions ?? data.session?.total_questions, nextQuestion, ...timing
        });
    } catch (error) {
        console.error("[writeAnswer] error:", error);
        return res.status(503).json({ success: false,
            message: "Unable to save your answer. Reconnect and restore the current question before continuing." });
    }
}

const saveAnswer = (req, res) => writeAnswer(req, res, true);
const saveDraft = (req, res) => writeAnswer(req, res, false);

// Saved selections only; neither question content nor correctness is exposed.
const getMyAnswers = async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!isUuid(sessionId)) return res.status(404).json({ success: false, message: "Exam session not found" });
        const { data: session, error: sessionError } = await supabase.from("exam_sessions")
            .select("id, candidate_id").eq("id", sessionId).maybeSingle();
        if (sessionError) throw sessionError;
        if (!session) return res.status(404).json({ success: false, message: "Exam session not found" });
        if (session.candidate_id !== req.student.candidateId) return res.status(403).json(SESSION_FORBIDDEN_BODY);
        const [{ data: answers, error }, { data: sequence, error: sequenceError }] = await Promise.all([
            supabase.from("exam_answers").select("question_id, subject_id, selected_option, is_attempted").eq("session_id", sessionId),
            supabase.from("exam_attempt_questions").select("question_id, subject_key, question_index, position").eq("session_id", sessionId)
        ]);
        if (error) throw error;
        if (sequenceError) throw sequenceError;
        const positions = new Map((sequence || []).map((row) => [row.question_id, row]));
        return res.json({ success: true, answers: (answers || []).map((answer) => {
            const row = positions.get(answer.question_id);
            return { questionId: answer.question_id, subjectId: answer.subject_id,
                subjectKey: row?.subject_key ?? null, questionNumber: row ? row.question_index + 1 : null,
                sequenceNumber: row ? row.position + 1 : null,
                selectedOption: answer.selected_option, isAttempted: answer.is_attempted };
        }) });
    } catch (error) {
        console.error("[getMyAnswers] error:", error);
        return res.status(503).json({ success: false, message: "Unable to fetch saved answers" });
    }
};

module.exports = { saveAnswer, saveDraft, getMyAnswers };
