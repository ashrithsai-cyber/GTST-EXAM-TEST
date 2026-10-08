// Shared helpers used by exam.controller.js, session.controller.js and
// answer.controller.js. Not a route file itself — nothing here is
// student-facing directly, but getQuestionAtPointer/advancePointer are
// what enforce "only the current question can be answered, and once
// answered it can never be revisited."
const supabase = require("../config/examSupabase");

async function getActiveExam() {
    const { data, error } = await supabase
        .from("exams")
        .select(EXAM_FIELDS)
        .eq("status", "ACTIVE")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

const EXAM_FIELDS = "id, exam_code, exam_name, status, seconds_per_question";

// Looks an exam up by id regardless of its ACTIVE/INACTIVE status. Once
// a student has a session, session.exam_id — resolved through this — is
// the ONLY source of truth for their exam: an admin activating a
// different exam mid-exam must never switch which exam, questions or
// timers an existing session sees. getActiveExam() above is only for
// deciding which exam a NEW session is created for.
async function getExamById(examId) {
    const { data, error } = await supabase
        .from("exams")
        .select(EXAM_FIELDS)
        .eq("id", examId)
        .maybeSingle();

    if (error) throw error;
    return data;
}

// The student's in-progress session, if any, across every exam. At most
// one should exist (enforced by exam_sessions_one_in_progress_per_candidate,
// 014_preflight_results_hardening.sql); newest first as a tiebreak for
// legacy data.
async function getInProgressSession(candidateId) {
    const { data, error } = await supabase
        .from("exam_sessions")
        .select("*")
        .eq("candidate_id", candidateId)
        .eq("status", "IN_PROGRESS")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

// Most recent session of any status — used to tell a student whose exam
// has ended/been blocked why there's nothing to resume.
async function getLatestSession(candidateId) {
    const { data, error } = await supabase
        .from("exam_sessions")
        .select("*")
        .eq("candidate_id", candidateId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

// Exam + class a student-facing endpoint should describe: the exam of
// their in-progress session when one exists, otherwise the currently
// active exam for their class (i.e. the one a new session would be
// created for). Same discriminated { exam, classRow, code } shape as
// getActiveExamForStudent.
async function getStudentExamContext(candidateId, studentClass) {
    const session = await getInProgressSession(candidateId);
    if (session) {
        const exam = await getExamById(session.exam_id);
        if (exam) return { exam, classRow: { id: session.class_id }, session, code: null };
    }
    const context = await getActiveExamForStudent(studentClass);
    return { ...context, session: null };
}

// Per-question timer for a session: the value snapshotted when the
// session was created, falling back to the session's own exam (never
// whichever exam happens to be active now) for pre-014 sessions.
function secondsPerQuestionFor(session, exam) {
    if (Number.isFinite(session?.seconds_per_question) && session.seconds_per_question > 0) {
        return session.seconds_per_question;
    }
    return exam?.seconds_per_question ?? 60;
}

// The optional overall-exam-window payload returned alongside questions.
// Omitted entirely (undefined) for an unscheduled exam.
function buildExamTimingPayload(timing, timingStatus) {
    if (!timingStatus.examEndAt) return undefined;
    return {
        examStartAt: timing.examStartAt,
        examEndAt: timingStatus.examEndAt,
        remainingSeconds: Math.max(0, Math.floor((new Date(timingStatus.examEndAt).getTime() - Date.now()) / 1000))
    };
}

// Returned when an authenticated student references a session that
// belongs to someone else.
const SESSION_FORBIDDEN_BODY = Object.freeze({
    success: false,
    message: "You do not have access to this exam session"
});

function isPastExamDeadline(timingStatus) {
    return Boolean(timingStatus.examEndAt) && Date.now() >= new Date(timingStatus.examEndAt).getTime();
}

// Registration data (exam_candidates.student_class, copied from the
// Registration DB) is bare digits: "6", "7", "9". Admins creating a
// class type things like "Class 6", "6", "Grade 6". Normalizing both
// sides to "the first integer found in the string" makes them compare
// equal without requiring an exact format match. A name with no digit
// at all normalizes to null and can never match a student — treated as
// a data-entry mistake for the admin to fix, not something to guess at.
function normalizeClassName(value) {
    if (value === null || value === undefined) return null;
    const match = String(value).match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
}

// Resolves the exam + class a given student should be served, using
// ONLY the server-verified studentClass off their JWT (see
// middleware/studentAuth.js) — never a client-supplied parameter, since
// this is the one thing standing between a student and another class's
// question bank. Returns a discriminated result rather than throwing
// for the two expected "nothing to show" cases, so callers can turn
// `code` into a clear 404 instead of a raw 500.
async function getActiveExamForStudent(studentClass) {
    const exam = await getActiveExam();
    if (!exam) return { exam: null, classRow: null, code: "NO_ACTIVE_EXAM" };

    const { data: classes, error } = await supabase
        .from("classes")
        .select("id, exam_id, class_name, display_order")
        .eq("exam_id", exam.id);

    if (error) throw error;

    const target = normalizeClassName(studentClass);
    const matched = target !== null
        ? classes.find((c) => normalizeClassName(c.class_name) === target)
        : undefined;

    if (!matched) return { exam, classRow: null, code: "NO_CLASS_CONTENT" };
    return { exam, classRow: matched, code: null };
}

// Fetched separately from getActiveExam() (used everywhere: login,
// current-question, save-answer, submit, etc.) so that if
// backend/sql/004_exam_date.sql hasn't been run yet in a given
// environment, the entire student exam flow keeps working exactly as
// before — only the exam_date display gracefully falls back to null
// instead of the whole login/exam pipeline breaking on a missing column.
async function getExamDate(examId) {
    try {
        const { data, error } = await supabase
            .from("exams")
            .select("exam_date")
            .eq("id", examId)
            .maybeSingle();

        if (error) throw error;
        return data?.exam_date || null;
    } catch (error) {
        console.warn("[getExamDate] exam_date unavailable (has backend/sql/004_exam_date.sql been run?):", error.message || error);
        return null;
    }
}

// Fetched separately from getActiveExam() for the same reason as
// getExamDate() above: an environment where backend/sql/012_exam_timing.sql
// hasn't been run yet must keep the entire student exam flow working
// exactly as before — exam_start_at/duration_minutes just come back null
// ("not scheduled") instead of breaking login/start/current-question.
async function getExamTiming(examId) {
    try {
        const { data, error } = await supabase
            .from("exams")
            .select("exam_start_at, duration_minutes")
            .eq("id", examId)
            .maybeSingle();

        if (error) throw error;
        return {
            examStartAt: data?.exam_start_at || null,
            durationMinutes: Number.isFinite(data?.duration_minutes) ? data.duration_minutes : null
        };
    } catch (error) {
        console.warn("[getExamTiming] exam timing unavailable (has backend/sql/012_exam_timing.sql been run?):", error.message || error);
        return { examStartAt: null, durationMinutes: null };
    }
}

// Derives the exam's scheduling status from a fixed [exam_start_at,
// exam_start_at + duration_minutes] window, purely from server clock
// (Date.now()) — never anything client-supplied. This is the single
// source of truth both the student-facing waiting-room gate (session/
// exam/answer controllers) and the admin Exams list's Scheduled/Live/
// Completed badge are computed from, so the two can never disagree.
//
// UNSCHEDULED (no exam_start_at at all) is a distinct, deliberately
// permissive status: it means this exam predates the Exam Timing
// feature (or an admin never set it), and every caller must treat it as
// "no gating, no overall deadline" — i.e. exactly today's behavior.
function computeTimingStatus({ examStartAt, durationMinutes }, now = Date.now()) {
    if (!examStartAt) {
        return { status: "UNSCHEDULED", examEndAt: null, secondsUntilStart: null, remainingSeconds: null };
    }

    const startMs = new Date(examStartAt).getTime();
    const endMs = Number.isFinite(durationMinutes) ? startMs + durationMinutes * 60000 : null;

    if (now < startMs) {
        return {
            status: "SCHEDULED",
            examEndAt: endMs ? new Date(endMs).toISOString() : null,
            secondsUntilStart: Math.ceil((startMs - now) / 1000),
            remainingSeconds: null
        };
    }

    if (endMs !== null && now >= endMs) {
        return { status: "COMPLETED", examEndAt: new Date(endMs).toISOString(), secondsUntilStart: 0, remainingSeconds: 0 };
    }

    return {
        status: "LIVE",
        examEndAt: endMs ? new Date(endMs).toISOString() : null,
        secondsUntilStart: 0,
        remainingSeconds: endMs !== null ? Math.max(0, Math.floor((endMs - now) / 1000)) : null
    };
}

// Shared scoring + finalization logic behind BOTH a student's own
// POST /session/submit (session.controller.js's submitExam) and the
// server-forced submission when the admin-scheduled exam window's
// deadline is reached mid-exam (session.controller.js's startSession,
// answer.controller.js's saveAnswer) — one scoring implementation, not
// two copies that could drift apart. Caller is responsible for having
// already verified session.status === "IN_PROGRESS".
//
// Correctness is re-derived here from each answer's selected_option
// against the question's CURRENT correct_option (not the is_correct
// snapshot taken when the answer was saved), so an admin correcting a
// wrong answer key before submissions close is reflected in the score.
async function scoreAndSubmitSession(session) {
    // Device-less callers may only close an attempt after its persisted
    // deadline, judged by the database clock. Manual submission uses
    // submit_exam_attempt instead. Returns null when the database has not
    // reached the deadline yet (this server's clock may run slightly ahead).
    const { error } = await supabase.rpc("expire_exam_attempts", { p_session_id: session.id });
    if (error) throw error;
    const { data, error: readError } = await supabase.from("exam_sessions")
        .select("status, submitted_at, total_questions").eq("id", session.id).single();
    if (readError) throw readError;
    if (data.status !== "SUBMITTED") return null;
    return { submittedAt: data.submitted_at, totalQuestions: data.total_questions };
}

// Every field here defaults to `true` — identical to today's hardcoded
// student-frontend behavior — so an environment where
// backend/sql/005_settings_and_presence.sql hasn't been run yet (or the
// table is simply empty) enforces exactly what it always has, rather
// than silently turning every check off. Callers (student-facing routes,
// proctoring.controller.js) must treat this as the single source of
// truth instead of hardcoding their own requirement checks.
const DEFAULT_SETTINGS = {
    cameraRequired: true,
    photoCaptureEnabled: true,
    microphoneRequired: true,
    fullscreenRequired: true,
    proctoringEnabled: true,
    faceDetectionEnabled: true,
    videoRequired: true,
    networkMonitoringEnabled: true,
    tabSwitchMonitoringEnabled: true
};

function mapSettingsRow(row) {
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
        cameraRequired: row.camera_required,
        photoCaptureEnabled: row.photo_capture_enabled ?? true,
        microphoneRequired: row.microphone_required,
        fullscreenRequired: row.fullscreen_required,
        proctoringEnabled: row.proctoring_enabled,
        faceDetectionEnabled: row.face_detection_enabled,
        videoRequired: row.video_required,
        networkMonitoringEnabled: row.network_monitoring_enabled,
        tabSwitchMonitoringEnabled: row.tab_switch_monitoring_enabled
    };
}

async function getExamSettings() {
    try {
        const { data, error } = await supabase
            .from("exam_settings")
            .select("*")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return mapSettingsRow(data);
    } catch (error) {
        console.warn("[getExamSettings] exam_settings unavailable (has backend/sql/005_settings_and_presence.sql been run?):", error.message || error);
        return { ...DEFAULT_SETTINGS };
    }
}

// Display-only presence stage for the admin Live Students page. Never
// throws — a missing student_presence table (005_settings_and_presence.sql
// not run yet) or any other failure here must never break the caller's
// actual flow (login, starting the exam, submitting it).
async function recordPresence(candidateId, stage) {
    try {
        const { error } = await supabase
            .from("student_presence")
            .upsert(
                { candidate_id: candidateId, stage, updated_at: new Date().toISOString() },
                { onConflict: "candidate_id" }
            );
        if (error) throw error;
    } catch (error) {
        console.warn(`[recordPresence] unable to record stage ${stage} (has 005_settings_and_presence.sql been run?):`, error.message || error);
    }
}

// A student whose attempt at the ACTIVE exam is already final must keep
// the COMPLETED presence stage; a later login or page visit is not a new
// attempt. Returns that attempt, or null.
async function getFinishedActiveAttempt(candidateId) {
    const session = await getLatestSession(candidateId);
    if (!session || !["SUBMITTED", "BLOCKED"].includes(session.status)) return null;
    const exam = await getExamById(session.exam_id);
    return exam?.status === "ACTIVE" ? session : null;
}

async function getSubjectsWithCounts(classId) {
    const { data: subjects, error: subjectsError } = await supabase
        .from("subjects")
        .select("id, subject_key, subject_name, display_order")
        .eq("class_id", classId)
        .order("display_order", { ascending: true });

    if (subjectsError) throw subjectsError;
    if (!subjects.length) return [];

    const { data: questions, error: questionsError } = await supabase
        .from("questions")
        .select("id, subject_id")
        .in("subject_id", subjects.map((s) => s.id))
        .eq("status", "ACTIVE");

    if (questionsError) throw questionsError;

    return subjects.map((s) => ({
        ...s,
        questionCount: questions.filter((q) => q.subject_id === s.id).length
    }));
}

// Resolves a (subjectIndex, questionIndex) pointer to the actual question
// row (including correct_option — callers of this must never forward it
// to a student-facing response). Returns null once the pointer is past
// the last question of the last subject, meaning the exam is complete.
//
// questionIndex is resolved as "the Nth remaining question of this subject,
// in question_number order" (a 0-based rank via .range()) rather than an
// exact `question_number = questionIndex + 1` equality match. An admin
// deleting a question never leaves the sequence dense (1..N with no
// gaps) — the old equality-match approach would then find nothing for
// the now-empty slot and incorrectly report the exam complete, even
// though later questions still exist. Ranking by order sidesteps gaps
// entirely: whatever currently exists is served, in order, until it
// genuinely runs out.
async function getQuestionAtPointer(subjects, subjectIndex, questionIndex) {
    const subject = subjects[subjectIndex];
    if (!subject) return null;

    if (questionIndex >= subject.questionCount) return null;

    const { data, error } = await supabase
        .from("questions")
        .select("id, subject_id, question_number, correct_option, marks")
        .eq("subject_id", subject.id)
        .order("question_number", { ascending: true })
        .range(questionIndex, questionIndex);

    if (error) throw error;
    return data?.[0] ?? null;
}

// Resolves a pointer to the question's DISPLAY content only — text,
// passage, options, marks. Never selects correct_option. This is what
// backs every student-facing "here is your current question" response
// (GET /current-question and the nextQuestion embed in saveAnswer), so
// it is structurally impossible for a future/unreached question's
// content to be sent before its turn — the server only ever resolves
// exactly the one question at the current or next pointer, never a list.
async function getQuestionDisplayAtPointer(subjects, subjectIndex, questionIndex) {
    const subject = subjects[subjectIndex];
    if (!subject) return null;

    if (questionIndex >= subject.questionCount) return null;

    const { data, error } = await supabase
        .from("questions")
        .select("id, subject_id, question_number, question_text, passage, option_a, option_b, option_c, option_d, marks")
        .eq("subject_id", subject.id)
        .order("question_number", { ascending: true })
        .range(questionIndex, questionIndex);

    if (error) throw error;
    return data?.[0] ?? null;
}

// Given the current pointer, returns the next one (advancing within the
// subject, or into the next subject once the current one is exhausted),
// or null once every question in the exam has been used up.
function advancePointer(subjects, subjectIndex, questionIndex) {
    const subject = subjects[subjectIndex];
    if (!subject) return null;

    if (questionIndex + 1 < subject.questionCount) {
        return { subjectIndex, questionIndex: questionIndex + 1 };
    }
    if (subjectIndex + 1 < subjects.length) {
        return { subjectIndex: subjectIndex + 1, questionIndex: 0 };
    }
    return null;
}

const ATTEMPT_DISPLAY_FIELDS = "session_id, position, question_id, subject_id, subject_index, question_index, subject_key, subject_name, question_number, question_text, passage, option_a, option_b, option_c, option_d, marks";

function attemptRpcError(data) {
    if (!data?.code) return null;
    const errors = {
        ACTIVE_SESSION_REQUIRED: [409, "Your exam is already active on another device."],
        NOT_FOUND: [404, "Exam session not found"],
        FORBIDDEN: [403, SESSION_FORBIDDEN_BODY.message],
        NOT_IN_PROGRESS: [403, "Exam is no longer in progress"],
        INVALID_OPTION: [400, "Selected option must be A, B, C or D"],
        STALE_QUESTION: [409, "This question is no longer active. Please restore the current question."],
        QUESTION_EXPIRED: [409, "Time expired for this question. Continue to the next question."],
        NO_QUESTIONS: [409, "No exam questions are available for your class."],
        OTHER_ATTEMPT_IN_PROGRESS: [409, "You already have an exam in progress. Please refresh the page."],
        INVALID_EXAM_CLASS: [409, "The exam class does not belong to this examination."],
        SEQUENCE_REQUIRED: [503, "Exam state is not initialized. Please resume your examination."]
    };
    const [status, message] = errors[data.code] || [503, "Unable to restore examination state"];
    return Object.assign(new Error(message), { status, code: data.code, attemptStatus: data.status });
}

async function initializeAttempt(session, student) {
    if (session.sequence_initialized_at) return session;
    const { data, error } = await supabase.rpc("init_exam_attempt", {
        p_session_id: session.id,
        p_candidate_id: student.candidateId,
        p_login_session_id: student.loginSessionId
    });
    if (error) throw error;
    const failure = attemptRpcError(data);
    if (failure) throw failure;
    if (!data?.sequence_initialized_at && data?.status === "IN_PROGRESS") {
        throw Object.assign(new Error("Examination sequence is unavailable"), { status: 503 });
    }
    return data;
}

async function getAttemptSubjects(sessionId) {
    const { data, error } = await supabase.from("exam_attempt_questions")
        .select("subject_id, subject_index, subject_key, subject_name, marks")
        .eq("session_id", sessionId).order("position", { ascending: true });
    if (error) throw error;
    const subjects = new Map();
    for (const row of data || []) {
        if (!subjects.has(row.subject_id)) subjects.set(row.subject_id, {
            id: row.subject_id, subjectIndex: row.subject_index,
            subject_key: row.subject_key, subject_name: row.subject_name,
            display_order: row.subject_index + 1, questionCount: 0, totalMarks: 0
        });
        const subject = subjects.get(row.subject_id);
        subject.questionCount += 1;
        subject.totalMarks += row.marks || 0;
    }
    return [...subjects.values()];
}

async function getAttemptQuestion(session) {
    const { data, error } = await supabase.from("exam_attempt_questions")
        .select(ATTEMPT_DISPLAY_FIELDS).eq("session_id", session.id)
        .eq("position", session.current_position).maybeSingle();
    if (error) throw error;
    return data;
}

function displayAttemptQuestion(row, subjects) {
    if (!row) return null;
    const subject = subjects.find((item) => item.id === row.subject_id);
    return {
        id: row.question_id, questionNumber: row.question_index + 1,
        sequenceNumber: row.position + 1,
        questionIndex: row.question_index, subjectIndex: row.subject_index,
        questionText: row.question_text, passage: row.passage,
        options: { A: row.option_a, B: row.option_b, C: row.option_c, D: row.option_d },
        marks: row.marks,
        subject: {
            subjectId: row.subject_id, subjectKey: row.subject_key,
            subjectName: row.subject_name, questionCount: subject?.questionCount || 0
        }
    };
}

function attemptTiming(session, now = Date.now()) {
    const questionDeadline = session.question_started_at
        ? Math.min(new Date(session.question_started_at).getTime() + session.seconds_per_question * 1000,
            new Date(session.deadline_at).getTime())
        : null;
    return {
        serverTime: new Date(now).toISOString(),
        questionDeadlineAt: questionDeadline === null ? null : new Date(questionDeadline).toISOString(),
        remainingSeconds: questionDeadline === null ? 0 : Math.max(0, Math.ceil((questionDeadline - now) / 1000)),
        examTiming: {
            examStartAt: session.started_at,
            examEndAt: session.deadline_at,
            remainingSeconds: Math.max(0, Math.ceil((new Date(session.deadline_at).getTime() - now) / 1000))
        }
    };
}

module.exports = {
    getActiveExam,
    getExamById,
    getInProgressSession,
    getLatestSession,
    getStudentExamContext,
    secondsPerQuestionFor,
    buildExamTimingPayload,
    isPastExamDeadline,
    SESSION_FORBIDDEN_BODY,
    normalizeClassName,
    getActiveExamForStudent,
    getExamDate,
    getExamTiming,
    computeTimingStatus,
    scoreAndSubmitSession,
    getExamSettings,
    recordPresence,
    getFinishedActiveAttempt,
    getSubjectsWithCounts,
    getQuestionAtPointer,
    getQuestionDisplayAtPointer,
    advancePointer,
    attemptRpcError,
    initializeAttempt,
    getAttemptSubjects,
    getAttemptQuestion,
    displayAttemptQuestion,
    attemptTiming
};
