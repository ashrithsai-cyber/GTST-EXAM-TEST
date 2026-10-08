const supabase = require("../config/examSupabase");
const { SESSION_FORBIDDEN_BODY, initializeAttempt, getAttemptSubjects } = require("./_examShared");
const { isUuid } = require("../utils/validation");

// Metadata supports progress display; there is no question-navigation write.
const getNavigation = async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isUuid(sessionId)) return res.status(404).json({ success: false, message: "Exam session not found" });
        const { data, error } = await supabase.from("exam_sessions").select("*").eq("id", sessionId).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Exam session not found" });
        if (data.candidate_id !== req.student.candidateId) return res.status(403).json(SESSION_FORBIDDEN_BODY);
        const session = await initializeAttempt(data, req.student);
        const [subjects, sequenceResult, answerResult] = await Promise.all([
            getAttemptSubjects(sessionId),
            supabase.from("exam_attempt_questions")
                .select("question_id, subject_id, subject_key, subject_name, subject_index, question_index, position")
                .eq("session_id", sessionId).order("position", { ascending: true }),
            supabase.from("exam_answers").select("question_id, selected_option, is_attempted").eq("session_id", sessionId)
        ]);
        if (sequenceResult.error) throw sequenceResult.error;
        if (answerResult.error) throw answerResult.error;
        const answers = new Map((answerResult.data || []).map((row) => [row.question_id, row]));
        return res.json({
            success: true, sequential: true, status: session.status,
            totalQuestions: session.total_questions, currentPosition: session.current_position,
            currentSubjectIndex: session.current_subject_index, currentQuestionIndex: session.current_question_index,
            subjects: subjects.map((subject) => ({
                subjectId: subject.id, subjectKey: subject.subject_key,
                subjectName: subject.subject_name, displayOrder: subject.display_order,
                subjectIndex: subject.subjectIndex, questionCount: subject.questionCount
            })),
            questions: (sequenceResult.data || []).map((row) => ({
                id: row.question_id, subjectId: row.subject_id, subjectKey: row.subject_key,
                subjectName: row.subject_name, subjectIndex: row.subject_index,
                questionIndex: row.question_index, questionNumber: row.question_index + 1,
                position: row.position, sequenceNumber: row.position + 1,
                answer: answers.get(row.question_id)?.selected_option || null,
                answered: Boolean(answers.get(row.question_id)?.is_attempted),
                visited: row.position <= session.current_position,
                locked: row.position < session.current_position
            }))
        });
    } catch (error) {
        console.error("[getNavigation] error:", error);
        return res.status(error.status || 503).json({ success: false, code: error.code,
            message: error.status ? error.message : "Unable to restore exam progress" });
    }
};

const sequentialOnly = (_req, res) => res.status(403).json({
    success: false, code: "SEQUENTIAL_EXAM",
    message: "Questions must be completed in order. Previous, bookmark and review actions are unavailable."
});

// Keep compatibility URLs explicitly denied so an older client cannot edit
// previous answers or restore arbitrary questions through the former API.
module.exports = {
    getNavigation, navigateQuestion: sequentialOnly,
    updateQuestionState: sequentialOnly, updateAnswer: sequentialOnly
};
