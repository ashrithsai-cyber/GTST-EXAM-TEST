const supabase = require("../config/examSupabase");
const {
    getExamById,
    getInProgressSession,
    getLatestSession,
    getStudentExamContext,
    secondsPerQuestionFor,
    scoreAndSubmitSession,
    getExamDate,
    getExamSettings,
    recordPresence,
    getFinishedActiveAttempt,
    getSubjectsWithCounts,
    initializeAttempt,
    getAttemptSubjects,
    getAttemptQuestion,
    displayAttemptQuestion,
    attemptTiming
} = require("./_examShared");

const NO_CLASS_CONTENT_MESSAGE = "No exam content is available yet for your class. Please check back later.";

// =====================================================
// GET EXAM INFO (metadata only, no question content)
//
// Backs the pre-exam Student Dashboard (src/pages/StudentDashboardPage.jsx)
// — duration, question/section counts and per-section names, all live
// from the exams/subjects/questions tables. Deliberately does NOT return
// question text/options/passages: unlike the exam-taking endpoints, this
// is fetched from a page the student can sit on indefinitely before
// starting, so it must not hand out the question bank early.
// =====================================================

const getExamInfo = async (req, res) => {
    try {
        const { exam, classRow, session, code } = await getStudentExamContext(req.student.candidateId, req.student.studentClass);
        if (code === "NO_ACTIVE_EXAM") return res.status(404).json({ success: false, message: "No active exam is configured" });
        if (code === "NO_CLASS_CONTENT") return res.status(404).json({ success: false, message: NO_CLASS_CONTENT_MESSAGE });
        const activeSession = session ? await initializeAttempt(session, req.student) : null;
        const subjects = activeSession
            ? await getAttemptSubjects(activeSession.id)
            : await getSubjectsWithCounts(classRow.id);
        let marks = [];
        if (!activeSession && subjects.length) {
            const { data, error } = await supabase.from("questions").select("subject_id, marks")
                .in("subject_id", subjects.map((subject) => subject.id)).eq("status", "ACTIVE");
            if (error) throw error;
            marks = data || [];
        }
        const secondsPerQuestion = secondsPerQuestionFor(activeSession, exam);
        const subjectSummaries = subjects.map((subject) => ({
            subjectId: subject.id, subjectKey: subject.subject_key,
            subjectName: subject.subject_name, displayOrder: subject.display_order,
            subjectIndex: subject.subjectIndex,
            questionCount: subject.questionCount,
            totalMarks: activeSession ? subject.totalMarks
                : marks.filter((question) => question.subject_id === subject.id).reduce((sum, question) => sum + (question.marks || 0), 0),
            durationSeconds: subject.questionCount * secondsPerQuestion
        }));
        const totalQuestions = subjectSummaries.reduce((sum, subject) => sum + subject.questionCount, 0);
        return res.json({ success: true, exam: {
            id: exam.id, examCode: exam.exam_code, examName: exam.exam_name,
            examDate: await getExamDate(exam.id), secondsPerQuestion, totalQuestions,
            totalMarks: subjectSummaries.reduce((sum, subject) => sum + subject.totalMarks, 0),
            totalDurationSeconds: totalQuestions * secondsPerQuestion
        }, subjects: subjectSummaries });
    } catch (error) {
        console.error("[getExamInfo] error:", error);
        return res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : "Unable to load exam information. Please try again." });
    }
};
// =====================================================
// GET CURRENT QUESTION
//
// Replaces the old "hand the student the entire question bank at exam
// start" endpoint. The server is authoritative for exactly one question
// at a time — whichever one exam_sessions.current_subject_index /
// current_question_index currently points to for THIS student's own
// session. A future/unreached question's text and options are never
// resolved, let alone sent, until the session's pointer actually reaches
// it (see getQuestionDisplayAtPointer in _examShared.js, and the
// `nextQuestion` embed in answer.controller.js's saveAnswer, which is
// what advances the client to the next question after a save — there is
// no separate "give me question N" endpoint a client could probe ahead
// with).
// =====================================================

const getCurrentQuestion = async (req, res) => {
    try {
        let session = (await getInProgressSession(req.student.candidateId)) || (await getLatestSession(req.student.candidateId));
        if (!session) return res.status(404).json({ success: false, message: "No exam session found. Start the exam first." });
        if (session.status !== "IN_PROGRESS") return res.status(403).json({
            success: false, status: session.status,
            message: session.status === "SUBMITTED" ? "This exam has already been submitted" : "This exam session is not in progress"
        });
        session = await initializeAttempt(session, req.student);
        if (Date.now() >= new Date(session.deadline_at).getTime() && await scoreAndSubmitSession(session)) {
            return res.status(403).json({ success: false, status: "SUBMITTED",
                message: "The examination time has ended. Your saved answers have been submitted automatically." });
        }
        const [exam, subjects, row] = await Promise.all([
            getExamById(session.exam_id), getAttemptSubjects(session.id), getAttemptQuestion(session)
        ]);
        if (!exam) return res.status(404).json({ success: false, message: "This exam is no longer available" });
        if (!row) return res.json({ success: true, examComplete: true, totalQuestions: session.total_questions });
        const { data: draft, error: draftError } = await supabase.from("exam_answers")
            .select("selected_option").eq("session_id", session.id).eq("question_id", row.question_id).maybeSingle();
        if (draftError) throw draftError;
        const question = displayAttemptQuestion(row, subjects);
        return res.json({
            success: true, examComplete: false, sessionId: session.id,
            exam: { id: exam.id, examName: exam.exam_name, secondsPerQuestion: session.seconds_per_question,
                totalQuestions: session.total_questions },
            subjectIndex: row.subject_index, questionIndex: row.question_index,
            totalSubjects: subjects.length, totalQuestions: session.total_questions,
            sequenceNumber: row.position + 1, currentPosition: row.position,
            subject: question.subject, question, selectedOption: draft?.selected_option ?? null,
            ...attemptTiming(session)
        });
    } catch (error) {
        console.error("[getCurrentQuestion] error:", error);
        return res.status(error.status || 503).json({ success: false, code: error.code,
            message: error.status ? error.message : "Unable to restore the current question. Please reconnect and try again." });
    }
};
// =====================================================
// GET EXAM SETTINGS (student-facing)
//
// Backs SystemCheckContext/SystemCheckPage and ExamProctoringRulesPage —
// only the boolean requirement flags, nothing sensitive. This is what
// makes an admin's toggle actually change student behavior instead of
// just the admin dashboard's own appearance: the student frontend reads
// this instead of hardcoding "camera required" etc.
// =====================================================

const getSettings = async (req, res) => {
    try {
        const settings = await getExamSettings();
        return res.status(200).json({ success: true, settings });
    } catch (error) {
        console.error("[getSettings] error:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to load exam settings"
        });
    }
};

// =====================================================
// POST STUDENT PRESENCE
//
// Lightweight, display-only stage tracking for the admin Live Students
// page (Logged In / System Check / Watching Rules / In Exam /
// Completed). Never read by anything security-sensitive — scoring,
// question delivery and session blocking all continue to rely solely on
// exam_sessions, untouched by this. Silently no-ops if
// backend/sql/005_settings_and_presence.sql hasn't been run yet, so a
// missing table here never breaks the actual exam flow.
// =====================================================

// LOGGED_IN/COMPLETED are recorded server-side, piggybacked onto the
// login/submit handlers themselves (more reliable than depending on a
// separate frontend call landing) — see auth.controller.js and
// _examShared.js. This endpoint covers the page-view stages with no
// natural backend touchpoint (System Check, Rules/Video) plus the
// IN_EXAM heartbeat the exam page sends every few seconds. That
// heartbeat keeps student_presence.updated_at fresh while a student sits
// on one question, which the admin "Disconnected" status is derived from.
const ALLOWED_STAGES = ["SYSTEM_CHECK", "RULES", "IN_EXAM"];

const postPresence = async (req, res) => {
    const { candidateId } = req.student;
    const { stage } = req.body;

    if (!ALLOWED_STAGES.includes(stage)) {
        return res.status(400).json({ success: false, message: "Invalid stage" });
    }

    try {
        // Never move a finished attempt's COMPLETED stage backwards.
        if (await getFinishedActiveAttempt(candidateId)) return res.status(200).json({ success: true, recorded: false });
    } catch (error) {
        console.warn("[postPresence] unable to check attempt status:", error.message || error);
    }
    await recordPresence(candidateId, stage);
    // Always 200 — this is display-only and must never block the
    // student's actual navigation over a missing table or a hiccup.
    return res.status(200).json({ success: true });
};

// =====================================================
// GET MY RESULT
//
// A student's own score for their most recently submitted exam — only
// once an admin has published results for that exam (exams.
// results_published, 014_preflight_results_hardening.sql). Unpublished
// (or not yet migrated) always reads as "not published"; nothing about
// the score leaks before then. Aggregates only — never the answer key or
// per-question correctness.
// =====================================================

const getMyResult = async (req, res) => {
    try {
        const { candidateId } = req.student;

        const { data: session, error: sessionError } = await supabase
            .from("exam_sessions")
            .select("id, exam_id, class_id, submitted_at, total_score, max_score, total_questions")
            .eq("candidate_id", candidateId)
            .eq("status", "SUBMITTED")
            .order("submitted_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (sessionError) throw sessionError;
        if (!session) return res.json({ success: true, submitted: false, published: false });

        const { count: attemptedQuestions, error: countError } = await supabase.from("exam_answers")
            .select("id", { count: "exact", head: true }).eq("session_id", session.id).eq("is_attempted", true);
        if (countError) throw countError;
        const completion = {
            sessionId: session.id, submittedAt: session.submitted_at,
            totalQuestions: session.total_questions, attemptedQuestions: attemptedQuestions || 0
        };

        const { data: exam, error: examError } = await supabase
            .from("exams")
            .select("exam_name, results_published")
            .eq("id", session.exam_id)
            .maybeSingle();

        if (examError) {
            console.warn("[getMyResult] results_published unavailable (has 014_preflight_results_hardening.sql been run?):", examError.message || examError);
            return res.json({ success: true, submitted: true, published: false, completion });
        }

        completion.examName = exam?.exam_name;

        if (!exam?.results_published) {
            return res.json({ success: true, submitted: true, published: false, completion });
        }

        const { data: answers, error: answersError } = await supabase
            .from("exam_answers")
            .select("question_id, selected_option")
            .eq("session_id", session.id);
        if (answersError) throw answersError;

        const { data: snapshot, error: snapshotError } = await supabase.from("exam_attempt_questions")
            .select("question_id, correct_option").eq("session_id", session.id);
        if (snapshotError) throw snapshotError;
        const keys = new Map(snapshot.map((question) => [question.question_id, question.correct_option]));
        let totalQuestions = session.total_questions ?? snapshot.length;
        // Preserve historical published results from before snapshot migration.
        if (!snapshot.length && session.total_questions == null) {
            const [{ data: legacy, error }, subjects] = await Promise.all([
                supabase.from("exam_answers").select("question_id, questions(correct_option)").eq("session_id", session.id),
                getSubjectsWithCounts(session.class_id)
            ]);
            if (error) throw error;
            for (const answer of legacy || []) keys.set(answer.question_id, answer.questions?.correct_option);
            totalQuestions = subjects.reduce((sum, subject) => sum + subject.questionCount, 0);
        }
        const correctAnswers = answers.filter((a) => a.selected_option && a.selected_option === keys.get(a.question_id)).length;
        const wrongAnswers = answers.filter((a) => a.selected_option && a.selected_option !== keys.get(a.question_id)).length;
        const totalScore = Number(session.total_score) || 0;
        const maxScore = Number(session.max_score) || 0;

        return res.json({
            success: true,
            submitted: true,
            published: true,
            completion,
            result: {
                examName: exam.exam_name,
                submittedAt: session.submitted_at,
                totalScore,
                maxScore,
                percentage: maxScore ? Math.round((totalScore / maxScore) * 1000) / 10 : 0,
                totalQuestions,
                correctAnswers,
                wrongAnswers,
                unanswered: Math.max(0, totalQuestions - correctAnswers - wrongAnswers)
            }
        });
    } catch (error) {
        console.error("[getMyResult] error:", error);
        return res.status(500).json({ success: false, message: "Unable to load your result. Please try again." });
    }
};

module.exports = {
    getExamInfo,
    getCurrentQuestion,
    getSettings,
    postPresence,
    getMyResult
};
