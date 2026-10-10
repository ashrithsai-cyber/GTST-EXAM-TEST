// Test-only transaction model. The actual migration is exercised separately
// in migration.test.js against PostgreSQL running locally through PGlite.
function attemptRpc(db, name, args) {
    const tables = db.tables;
    const now = new Date().toISOString();
    const result = (data) => ({ data: JSON.parse(JSON.stringify(data)), error: null });
    const sessions = tables.exam_sessions || [];
    const s = sessions.find((row) => row.id === args.p_session_id);
    const sequence = () => (tables.exam_attempt_questions || []).filter((q) => q.session_id === s?.id).sort((a, b) => a.position - b.position);
    const lease = (tables.student_login_sessions || []).find((row) => row.candidate_id === args.p_candidate_id);
    const validLease = lease && lease.login_session_id === args.p_login_session_id &&
        new Date(lease.expires_at).getTime() > Date.now() && new Date(lease.token_expires_at).getTime() > Date.now();
    const finalize = (session) => {
        if (!["IN_PROGRESS", "SUBMITTED"].includes(session.status)) return { code: "NOT_IN_PROGRESS", status: session.status };
        if (!session.sequence_initialized_at) return { code: "SEQUENCE_REQUIRED" };
        const qs = (tables.exam_attempt_questions || []).filter((q) => q.session_id === session.id);
        const answers = (tables.exam_answers || []).filter((a) => a.session_id === session.id);
        if (session.status === "IN_PROGRESS") {
            session.total_score = qs.reduce((score, q) => {
                const answer = answers.find((a) => a.question_id === q.question_id);
                return score + (answer?.selected_option === q.correct_option ? q.marks : 0);
            }, 0);
            session.max_score = qs.reduce((score, q) => score + q.marks, 0);
            Object.assign(session, { status: "SUBMITTED", submitted_at: now, last_activity_at: now, question_started_at: null });
            tables.student_presence ||= [];
            const presence = tables.student_presence.find((row) => row.candidate_id === session.candidate_id);
            if (presence) Object.assign(presence, { stage: "COMPLETED", updated_at: now });
            else tables.student_presence.push({ candidate_id: session.candidate_id, stage: "COMPLETED", updated_at: now });
        }
        return { status: session.status, submittedAt: session.submitted_at,
            attemptedCount: answers.filter((a) => a.selected_option).length, totalQuestions: session.total_questions };
    };
    if (name === "expire_exam_attempts") {
        let count = 0;
        for (const session of sessions) {
            if (session.status === "IN_PROGRESS" && session.deadline_at <= now &&
                (!args.p_session_id || args.p_session_id === session.id)) {
                finalize(session); count++;
            }
        }
        return result(count);
    }
    if (name === "start_exam_attempt") {
        // Mirrors 019: create + initialize atomically, or keep nothing.
        if (!validLease) return result({ code: "ACTIVE_SESSION_REQUIRED" });
        const existing = sessions.find((row) => row.candidate_id === args.p_candidate_id && row.exam_id === args.p_exam_id);
        if (existing) return result({ created: false, session: existing });
        if (sessions.some((row) => row.candidate_id === args.p_candidate_id && row.status === "IN_PROGRESS")) {
            return result({ code: "OTHER_ATTEMPT_IN_PROGRESS" });
        }
        const created = { id: require("node:crypto").randomUUID(), candidate_id: args.p_candidate_id,
            exam_id: args.p_exam_id, class_id: args.p_class_id, status: "IN_PROGRESS",
            current_subject_index: 0, current_question_index: 0, seconds_per_question: args.p_seconds_per_question,
            started_at: now, question_started_at: now, last_activity_at: now, proctoring_warning_count: 0, created_at: now };
        tables.exam_sessions ||= [];
        tables.exam_sessions.push(created);
        const initialized = attemptRpc(db, "init_exam_attempt", { ...args, p_session_id: created.id });
        if (initialized.data?.code) {
            tables.exam_sessions = tables.exam_sessions.filter((row) => row !== created);
            tables.exam_attempt_questions = (tables.exam_attempt_questions || []).filter((row) => row.session_id !== created.id);
            return result({ code: initialized.data.code });
        }
        return result({ created: true, session: initialized.data });
    }
    if (!["init_exam_attempt", "save_exam_answer", "submit_exam_attempt", "block_exam_attempt"].includes(name)) return undefined;
    if (!validLease) return result({ code: "ACTIVE_SESSION_REQUIRED" });
    if (!s) return result({ code: "NOT_FOUND" });
    if (s.candidate_id !== args.p_candidate_id) return result({ code: "FORBIDDEN" });
    if (name === "init_exam_attempt") {
        if (s.sequence_initialized_at || s.status !== "IN_PROGRESS") return result(s);
        const exam = tables.exams.find((e) => e.id === s.exam_id);
        if (!(tables.classes || []).some((c) => c.id === s.class_id && c.exam_id === s.exam_id)) return result({ code: "INVALID_EXAM_CLASS" });
        const subjects = tables.subjects.filter((subject) => subject.class_id === s.class_id).sort((a, b) => a.display_order - b.display_order);
        const rows = [];
        subjects.forEach((subject, subjectIndex) => {
            const questions = tables.questions.filter((q) => q.subject_id === subject.id && (q.status || "ACTIVE") === "ACTIVE")
                .sort((a, b) => a.question_number - b.question_number);
            if (exam.randomize_questions && s.current_subject_index === 0 && s.current_question_index === 0 &&
                !(tables.exam_answers || []).some((a) => a.session_id === s.id)) {
                for (let index = questions.length - 1; index > 0; index--) {
                    const randomIndex = Math.floor(Math.random() * (index + 1));
                    [questions[index], questions[randomIndex]] = [questions[randomIndex], questions[index]];
                }
            }
            questions.forEach((q, questionIndex) => rows.push({
                ...q, question_id: q.id, session_id: s.id, position: rows.length,
                subject_index: subjectIndex, question_index: questionIndex,
                subject_key: subject.subject_key, subject_name: subject.subject_name
            }));
        });
        if (!rows.length) return result({ code: "NO_QUESTIONS" });
        tables.exam_attempt_questions ||= [];
        tables.exam_attempt_questions.push(...rows);
        const initial = rows.find((q) => q.subject_index === s.current_subject_index && q.question_index === s.current_question_index);
        const position = initial?.position ?? (s.current_subject_index === 0 && s.current_question_index === 0 ? 0 : rows.length);
        const first = rows[position];
        const seconds = Math.max(1, s.seconds_per_question ?? exam.seconds_per_question);
        let deadline = new Date(s.started_at || now).getTime() + rows.length * seconds * 1000;
        if (exam.exam_start_at && exam.duration_minutes != null) deadline = Math.min(deadline, new Date(exam.exam_start_at).getTime() + exam.duration_minutes * 60000);
        Object.assign(s, { sequence_initialized_at: now, current_position: position, total_questions: rows.length,
            deadline_at: new Date(deadline).toISOString(), seconds_per_question: seconds,
            current_subject_index: first?.subject_index ?? s.current_subject_index,
            current_question_index: first?.question_index ?? s.current_question_index,
            question_started_at: first ? s.question_started_at || now : null,
            max_score: rows.reduce((sum, q) => sum + q.marks, 0) });
        return result(s);
    }
    if (name === "submit_exam_attempt") return result(finalize(s));
    if (name === "block_exam_attempt") {
        // Mirrors 019: only a running attempt can become BLOCKED.
        if (["IN_PROGRESS", "NOT_STARTED"].includes(s.status)) {
            Object.assign(s, { status: "BLOCKED", last_activity_at: now, question_started_at: null,
                proctoring_warning_count: Math.max(s.proctoring_warning_count || 0, args.p_max_warnings) });
        }
        return result({ status: s.status, blocked: s.status === "BLOCKED",
            warningCount: s.proctoring_warning_count, submittedAt: s.submitted_at || null });
    }
    if (args.p_selected_option != null && !["A", "B", "C", "D"].includes(args.p_selected_option)) return result({ code: "INVALID_OPTION" });
    if (s.status !== "IN_PROGRESS") return result({ code: "NOT_IN_PROGRESS", status: s.status });
    if (!s.sequence_initialized_at) return result({ code: "SEQUENCE_REQUIRED" });
    if (s.deadline_at <= now) return result({ ...finalize(s), autoSubmitted: true, examComplete: true, timedOut: true });
    const q = sequence().find((row) => row.position === s.current_position);
    if (!q || q.question_id !== args.p_question_id) return result({ code: "STALE_QUESTION" });
    const expired = Date.now() >= new Date(s.question_started_at).getTime() + s.seconds_per_question * 1000;
    const advance = args.p_advance ?? true;
    tables.exam_answers ||= [];
    const existing = tables.exam_answers.find((a) => a.session_id === s.id && a.question_id === q.question_id);
    const option = expired ? existing?.selected_option ?? null :
        advance && args.p_selected_option == null && existing ? existing.selected_option : args.p_selected_option;
    if (expired && !advance) return result({ code: "QUESTION_EXPIRED" });
    const answer = { session_id: s.id, question_id: q.question_id, subject_id: q.subject_id,
        selected_option: option, is_attempted: option != null, is_correct: option === q.correct_option,
        time_spent_seconds: Math.max(0, Math.min(s.seconds_per_question, Math.floor((Date.now() - new Date(s.question_started_at).getTime()) / 1000))),
        answered_at: now };
    if (existing) Object.assign(existing, answer); else tables.exam_answers.push(answer);
    s.last_activity_at = now;
    if (!advance) return result({ status: s.status, selectedOption: option, serverTime: now });
    s.current_position += 1;
    const next = sequence().find((row) => row.position === s.current_position);
    Object.assign(s, { current_subject_index: next?.subject_index ?? s.current_subject_index + 1,
        current_question_index: next?.question_index ?? 0, question_started_at: next ? now : null });
    const response = { status: s.status, currentPosition: s.current_position,
        nextSubjectIndex: next?.subject_index ?? null, nextQuestionIndex: next?.question_index ?? null,
        sectionComplete: Boolean(next && next.subject_index !== q.subject_index), examComplete: !next,
        timedOut: expired, serverTime: now, session: { ...s } };
    return result(next ? response : { ...response, ...finalize(s), autoSubmitted: true });
}

module.exports = { attemptRpc };
