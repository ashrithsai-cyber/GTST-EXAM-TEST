// Attempt integrity through the real Express routes with isolated database
// doubles: proctoring vs submission races, atomic attempt creation, explicit
// cross-student / device / deadline attacks, admin device-session release,
// and completed-student presence. The SQL itself is exercised separately in
// realMigrations.test.js and postgres.concurrency.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
process.env.STUDENT_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
const jwt = require("jsonwebtoken");
const { createMemorySupabase } = require("./helpers/memorySupabase");
const { attemptRpc } = require("./helpers/attemptRpc");

const ids = {
    exam: crypto.randomUUID(), otherExam: crypto.randomUUID(),
    class10: crypto.randomUUID(), class9: crypto.randomUUID(), otherClass: crypto.randomUUID(),
    subject10: crypto.randomUUID(), subject9: crypto.randomUUID(), otherSubject: crypto.randomUUID(),
    q1: crypto.randomUUID(), q2: crypto.randomUUID(), q3: crypto.randomUUID(),
    otherExamQuestion: crypto.randomUUID(), admin: crypto.randomUUID()
};
const now = new Date().toISOString();
const question = (id, subjectId, number) => ({ id, subject_id: subjectId, question_number: number, question_text: `Q${number}?`,
    passage: null, option_a: "1", option_b: "2", option_c: "3", option_d: "4", correct_option: "B", marks: 1, status: "ACTIVE" });
const db = createMemorySupabase({
    exams: [
        { id: ids.exam, exam_code: "INTEGRITY", exam_name: "Integrity", status: "ACTIVE", seconds_per_question: 60, created_at: now, exam_start_at: null, duration_minutes: null },
        { id: ids.otherExam, exam_code: "OTHER", exam_name: "Other", status: "INACTIVE", seconds_per_question: 60, created_at: now, exam_start_at: null, duration_minutes: null }
    ],
    classes: [
        { id: ids.class10, exam_id: ids.exam, class_name: "Class 10", display_order: 1 },
        { id: ids.class9, exam_id: ids.exam, class_name: "Class 9", display_order: 2 },
        { id: ids.otherClass, exam_id: ids.otherExam, class_name: "Class 10", display_order: 1 }
    ],
    subjects: [
        { id: ids.subject10, class_id: ids.class10, subject_key: "maths", subject_name: "Mathematics", display_order: 1 },
        { id: ids.subject9, class_id: ids.class9, subject_key: "maths", subject_name: "Mathematics", display_order: 1 },
        { id: ids.otherSubject, class_id: ids.otherClass, subject_key: "maths", subject_name: "Mathematics", display_order: 1 }
    ],
    // Class 9 deliberately starts with no questions (failed initialization).
    questions: [question(ids.q1, ids.subject10, 1), question(ids.q2, ids.subject10, 2), question(ids.q3, ids.subject10, 3),
        question(ids.otherExamQuestion, ids.otherSubject, 1)],
    exam_settings: [{ camera_required: false, photo_capture_enabled: false, microphone_required: false, fullscreen_required: false,
        proctoring_enabled: true, face_detection_enabled: false, video_required: false, network_monitoring_enabled: true,
        tab_switch_monitoring_enabled: true, created_at: now }],
    exam_candidates: [], exam_sessions: [], student_login_sessions: [], student_presence: [], admin_audit_logs: [],
    admin_users: [{ id: ids.admin, name: "Admin", email: "admin@example.invalid", password_hash: "x", role: "admin", is_active: true, created_at: now }]
});
const registrationDb = createMemorySupabase({ registrations: [] });
for (const [file, client] of [["examSupabase.js", db], ["registrationSupabase.js", registrationDb]]) {
    const filename = path.join(__dirname, "..", "src", "config", file);
    require.cache[filename] = { id: filename, filename, loaded: true, exports: client };
}

// Runs a callback immediately before the next matching database call is
// built, i.e. inside the window between two backend statements. Used to
// land a real submission between the warning update and the block.
const hooks = [];
const realFrom = db.from;
db.from = (table) => {
    const query = realFrom(table);
    const realInsert = query.insert.bind(query);
    query.insert = (payload) => {
        const index = hooks.findIndex((hook) => hook.table === table && hook.match(payload));
        if (index >= 0) hooks.splice(index, 1)[0].run();
        return realInsert(payload);
    };
    const index = hooks.findIndex((hook) => hook.table === table && hook.onRead);
    if (index >= 0) hooks.splice(index, 1)[0].run();
    return query;
};
const realRpc = db.rpc;
const rpcOverrides = new Map();
db.rpc = async (name, args) => (rpcOverrides.has(name) ? rpcOverrides.get(name)(args) : realRpc(name, args));

const app = require("../src/server");
let server;
let baseUrl;
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, route, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, body: json };
}
const adminToken = () => jwt.sign({ adminId: ids.admin, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
const tables = db.db.tables;
const sessionRow = (id) => tables.exam_sessions.find((row) => row.id === id);
const leaseFor = (candidateId) => tables.student_login_sessions.find((row) => row.candidate_id === candidateId);

function candidate(studentClass = "10") {
    const id = crypto.randomUUID();
    const registrationId = `REG-${id}`;
    const hallTicketNumber = `HT-${id}`;
    registrationDb.db.tables.registrations.push({ id: crypto.randomUUID(), registration_id: registrationId,
        hall_ticket_number: hallTicketNumber, full_name: "Integrity Student", student_class: studentClass, payment_status: "SUCCESS" });
    tables.exam_candidates.push({ id, registration_id: registrationId, full_name: "Integrity Student", student_class: studentClass });
    return { id, registrationId, hallTicketNumber };
}
const login = (student, token) => call("POST", "/api/exam/auth/login", {
    token, body: { registrationId: student.registrationId, hallTicketNumber: student.hallTicketNumber } });

async function startExam(studentClass = "10") {
    const student = candidate(studentClass);
    const loggedIn = await login(student);
    assert.equal(loggedIn.status, 200);
    const token = loggedIn.body.token;
    assert.equal((await call("POST", "/api/exam/preflight/system-check", { token, body: {} })).status, 200);
    assert.equal((await call("POST", "/api/exam/preflight/rules-accepted", { token })).status, 200);
    const started = await call("POST", "/api/exam/session/start", { token });
    return { student, token, started, sessionId: started.body?.session?.id };
}
function submitDirectly(sessionId) {
    // The same transaction a concurrent POST /session/submit commits.
    const s = sessionRow(sessionId);
    const result = attemptRpc(db.db, "submit_exam_attempt", { p_session_id: sessionId, p_candidate_id: s.candidate_id,
        p_login_session_id: leaseFor(s.candidate_id).login_session_id });
    assert.equal(result.data.status, "SUBMITTED");
}

// ---------------------------------------------------------------------
// PRIORITY 1: proctoring block vs submission
// ---------------------------------------------------------------------

test("Proctoring only captures violations: no limit, and the attempt is never blocked", async () => {
    const a = await startExam();
    for (let i = 1; i <= 5; i++) {
        const res = await call("POST", "/api/exam/proctoring/event", { token: a.token, body: { sessionId: a.sessionId, eventType: "TAB_SWITCH" } });
        assert.equal(res.status, 200);
        assert.equal(res.body.recorded, true);
        assert.equal(res.body.blocked, false);
        assert.equal(res.body.violationCount, i);
    }
    assert.equal(sessionRow(a.sessionId).status, "IN_PROGRESS");
    assert.equal(sessionRow(a.sessionId).proctoring_warning_count, 5, "running violation total");
    const current = (await call("GET", "/api/exam/current-question", { token: a.token })).body.question.id;
    const res = await call("POST", "/api/exam/answers", { token: a.token, body: { sessionId: a.sessionId, questionId: current, selectedOption: "B" } });
    assert.equal(res.status, 200, "the exam continues after any number of violations");
});

test("Informational events are recorded without adding to the violation total", async () => {
    const a = await startExam();
    const res = await call("POST", "/api/exam/proctoring/event", { token: a.token, body: { sessionId: a.sessionId, eventType: "COPY_PASTE" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, true);
    assert.equal(res.body.violation, false);
    assert.equal(sessionRow(a.sessionId).proctoring_warning_count, 0);
});

test('Offline violations retry once, including a pre-submission event delivered after completion', async () => {
    const a = await startExam();
    const body = { sessionId: a.sessionId, eventType: 'TAB_SWITCH', clientEventId: crypto.randomUUID(), occurredAt: new Date().toISOString() };
    const first = await call('POST', '/api/exam/proctoring/event', { token: a.token, body });
    assert.equal(first.status, 200);
    const retry = await call('POST', '/api/exam/proctoring/event', { token: a.token, body });
    assert.equal(retry.body.duplicate, true);
    assert.equal(sessionRow(a.sessionId).proctoring_warning_count, 1);
    const delayed = { ...body, clientEventId: crypto.randomUUID() };
    submitDirectly(a.sessionId);
    const saved = await call('POST', '/api/exam/proctoring/event', { token: a.token, body: delayed });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.violationCount, 2);
    assert.equal(sessionRow(a.sessionId).status, 'SUBMITTED');
});

test('Stricter fullscreen requirements invalidate a previously completed preflight before a new attempt', async () => {
    const student = candidate('10');
    const loggedIn = await login(student); const token = loggedIn.body.token;
    assert.equal((await call('POST', '/api/exam/preflight/system-check', { token, body: {} })).status, 200);
    assert.equal((await call('POST', '/api/exam/preflight/rules-accepted', { token })).status, 200);
    const settings = db.db.tables.exam_settings[0]; settings.fullscreen_required = true;
    try {
        const result = await call('POST', '/api/exam/session/start', { token });
        assert.equal(result.status, 403); assert.equal(result.body.code, 'PREFLIGHT_REQUIRED');
        assert.equal(db.db.tables.exam_sessions.some(s => s.candidate_id === student.id), false);
    } finally { settings.fullscreen_required = false; }
});

test("A violation reported after submission is refused and the attempt stays SUBMITTED", async () => {
    const a = await startExam();
    await submitDirectly(a.sessionId);
    const res = await call("POST", "/api/exam/proctoring/event", { token: a.token, body: { sessionId: a.sessionId, eventType: "TAB_SWITCH" } });
    assert.equal(res.status, 403);
    assert.equal(sessionRow(a.sessionId).status, "SUBMITTED");
});

// ---------------------------------------------------------------------
// PRIORITY 7: attempt creation atomicity
// ---------------------------------------------------------------------

test("A failed attempt initialization keeps no session; the retry creates exactly one usable attempt", async () => {
    const a = await startExam("9"); // Class 9 has no questions yet.
    assert.equal(a.started.status, 409);
    assert.equal(a.started.body.code, "NO_QUESTIONS");
    assert.equal(tables.exam_sessions.filter((row) => row.candidate_id === a.student.id).length, 0, "no unusable session row");

    tables.questions.push(question(crypto.randomUUID(), ids.subject9, 1));
    const retry = await call("POST", "/api/exam/session/start", { token: a.token });
    assert.equal(retry.status, 200);
    const rows = tables.exam_sessions.filter((row) => row.candidate_id === a.student.id);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].sequence_initialized_at);
    assert.equal((await call("GET", "/api/exam/current-question", { token: a.token })).status, 200);
});

test("Concurrent session starts for one student create a single attempt", async () => {
    const student = candidate();
    const token = (await login(student)).body.token;
    await call("POST", "/api/exam/preflight/system-check", { token, body: {} });
    await call("POST", "/api/exam/preflight/rules-accepted", { token });
    const results = await Promise.all([1, 2, 3].map(() => call("POST", "/api/exam/session/start", { token })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(new Set(results.map((r) => r.body.session.id)).size, 1);
    assert.equal(tables.exam_sessions.filter((row) => row.candidate_id === student.id).length, 1);
});

test("A legacy session left uninitialized is recovered on the next start, not duplicated", async () => {
    const student = candidate();
    const token = (await login(student)).body.token;
    const legacyId = crypto.randomUUID();
    tables.exam_sessions.push({ id: legacyId, candidate_id: student.id, exam_id: ids.exam, class_id: ids.class10,
        status: "IN_PROGRESS", current_subject_index: 0, current_question_index: 0, seconds_per_question: 60,
        started_at: new Date().toISOString(), question_started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), created_at: now });
    const res = await call("POST", "/api/exam/session/start", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.session.id, legacyId);
    assert.ok(sessionRow(legacyId).sequence_initialized_at);
    assert.equal(tables.exam_sessions.filter((row) => row.candidate_id === student.id).length, 1);
});

// ---------------------------------------------------------------------
// PRIORITY 10: explicit backend security
// ---------------------------------------------------------------------

test("A student cannot submit or complete another student's attempt", async () => {
    const a = await startExam();
    const b = await startExam();
    let res = await call("POST", "/api/exam/session/submit", { token: a.token, body: { sessionId: b.sessionId } });
    assert.equal(res.status, 403);
    // Completing B by answering B's whole sequence from A's account.
    for (const questionId of [ids.q1, ids.q2, ids.q3]) {
        res = await call("POST", "/api/exam/answers", { token: a.token, body: { sessionId: b.sessionId, questionId, selectedOption: "B" } });
        assert.equal(res.status, 403);
    }
    res = await call("POST", "/api/exam/answers/draft", { token: a.token, body: { sessionId: b.sessionId, questionId: ids.q1, selectedOption: "B" } });
    assert.equal(res.status, 403);
    res = await call("GET", `/api/exam/navigation?sessionId=${b.sessionId}`, { token: a.token });
    assert.equal(res.status, 403);
    assert.equal(sessionRow(b.sessionId).status, "IN_PROGRESS");
    assert.equal(sessionRow(b.sessionId).current_position, 0);
    assert.equal((tables.exam_answers || []).filter((row) => row.session_id === b.sessionId).length, 0);
});

test("Question IDs outside the student's own current sequence position are rejected", async () => {
    const a = await startExam();
    const current = (await call("GET", "/api/exam/current-question", { token: a.token })).body.question.id;
    const foreign = [ids.otherExamQuestion, tables.questions.find((q) => q.subject_id === ids.subject9).id,
        [ids.q1, ids.q2, ids.q3].find((id) => id !== current)];
    for (const questionId of foreign) {
        for (const route of ["/api/exam/answers", "/api/exam/answers/draft"]) {
            const res = await call("POST", route, { token: a.token, body: { sessionId: a.sessionId, questionId, selectedOption: "B" } });
            assert.equal(res.status, 409, `${route} ${questionId}`);
            assert.equal(res.body.code, "STALE_QUESTION");
        }
    }
    assert.equal(sessionRow(a.sessionId).current_position, 0);
    assert.equal((tables.exam_answers || []).filter((row) => row.session_id === a.sessionId).length, 0);
});

test("The persisted sequence, exam and deadline cannot be changed from the client", async () => {
    const a = await startExam();
    const before = JSON.stringify(tables.exam_attempt_questions.filter((row) => row.session_id === a.sessionId));
    const session = { ...sessionRow(a.sessionId) };
    for (const [method, route] of [["POST", "/api/exam/navigation/question"], ["PATCH", "/api/exam/navigation/state"], ["PATCH", "/api/exam/navigation/answer"]]) {
        const res = await call(method, route, { token: a.token, body: { sessionId: a.sessionId, questionId: ids.q3, position: 0, sequence: [ids.q3, ids.q2, ids.q1] } });
        assert.equal(res.status, 403, route);
        assert.equal(res.body.code, "SEQUENTIAL_EXAM");
    }
    const res = await call("POST", "/api/exam/session/start", { token: a.token, body: {
        examId: ids.otherExam, classId: ids.otherClass, deadlineAt: "2099-01-01T00:00:00Z", startedAt: "2099-01-01T00:00:00Z",
        secondsPerQuestion: 99999, currentPosition: 2 } });
    assert.equal(res.status, 200);
    const current = (await call("GET", "/api/exam/current-question", { token: a.token })).body.question.id;
    await call("POST", "/api/exam/answers", { token: a.token, body: { sessionId: a.sessionId, questionId: current, selectedOption: "B", timeSpentSeconds: -99999 } });
    const after = sessionRow(a.sessionId);
    assert.equal(after.exam_id, ids.exam);
    assert.equal(after.class_id, ids.class10);
    assert.equal(after.deadline_at, session.deadline_at, "deadline unchanged");
    assert.equal(after.started_at, session.started_at);
    assert.equal(after.seconds_per_question, 60);
    assert.equal(JSON.stringify(tables.exam_attempt_questions.filter((row) => row.session_id === a.sessionId)), before, "sequence unchanged");
    const answer = tables.exam_answers.find((row) => row.session_id === a.sessionId);
    assert.ok(answer.time_spent_seconds >= 0 && answer.time_spent_seconds <= 60, "time spent is measured by the server");
});

test("Nothing can be saved, submitted or restarted after completion", async () => {
    const a = await startExam();
    assert.equal((await call("POST", "/api/exam/session/submit", { token: a.token, body: { sessionId: a.sessionId } })).status, 200);
    const submitted = { ...sessionRow(a.sessionId) };
    for (const route of ["/api/exam/answers", "/api/exam/answers/draft"]) {
        const res = await call("POST", route, { token: a.token, body: { sessionId: a.sessionId, questionId: ids.q1, selectedOption: "D" } });
        assert.equal(res.status, 403, route);
        assert.equal(res.body.status, "SUBMITTED");
    }
    const again = await call("POST", "/api/exam/session/submit", { token: a.token, body: { sessionId: a.sessionId } });
    assert.equal(again.status, 200);
    assert.equal(again.body.submittedAt, submitted.submitted_at, "a repeated submit does not move the completion time");
    assert.equal((await call("POST", "/api/exam/session/start", { token: a.token })).status, 403);
    assert.equal((await call("GET", "/api/exam/current-question", { token: a.token })).status, 403);
    assert.equal(tables.exam_sessions.filter((row) => row.candidate_id === a.student.id).length, 1);
    assert.deepEqual(sessionRow(a.sessionId), submitted);
});

test("Device protection cannot be bypassed through direct API calls", async () => {
    const a = await startExam();
    // Device B: correct credentials, rejected at login, receives no token.
    const deviceB = await login(a.student);
    assert.equal(deviceB.status, 409);
    assert.equal(deviceB.body.token, undefined);
    // A validly signed token for a lease that is not the active one.
    const forged = jwt.sign({ candidateId: a.student.id, registrationId: a.student.registrationId, studentClass: "10",
        loginSessionId: crypto.randomUUID(), typ: "student" }, process.env.STUDENT_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
    const current = (await call("GET", "/api/exam/current-question", { token: a.token })).body.question.id;
    for (const [method, route, body] of [
        ["POST", "/api/exam/answers", { sessionId: a.sessionId, questionId: current, selectedOption: "B" }],
        ["POST", "/api/exam/session/submit", { sessionId: a.sessionId }],
        ["POST", "/api/exam/proctoring/event", { sessionId: a.sessionId, eventType: "TAB_SWITCH" }],
        ["GET", "/api/exam/current-question", undefined]]) {
        assert.equal((await call(method, route, { token: forged, body })).status, 409, route);
    }
    assert.equal(sessionRow(a.sessionId).status, "IN_PROGRESS");
    assert.equal(sessionRow(a.sessionId).current_position, 0);
    // Device A continues normally.
    assert.equal((await call("GET", "/api/exam/current-question", { token: a.token })).status, 200);
});

// ---------------------------------------------------------------------
// PRIORITY 8: admin device-session management
// ---------------------------------------------------------------------

test("Admins can view and release a stuck device session, with an audit record and no takeover", async () => {
    const a = await startExam();
    const route = `/api/admin/candidates/${a.student.id}/device-session`;
    // Students can neither view nor release.
    assert.equal((await call("GET", route, { token: a.token })).status, 401);
    assert.equal((await call("POST", `${route}/release`, { token: a.token, body: { reason: "student attempt" } })).status, 401);

    let res = await call("GET", route, { token: adminToken() });
    assert.equal(res.status, 200);
    assert.equal(res.body.deviceSession.active, true);
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(leaseFor(a.student.id).login_session_id));

    assert.equal((await call("POST", `${route}/release`, { token: adminToken(), body: {} })).status, 400);
    res = await call("POST", `${route}/release`, { token: adminToken(), body: { reason: "Laptop crashed, moving to spare device" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.token, undefined, "release never issues a student token");
    const audit = tables.admin_audit_logs.find((row) => row.action === "RELEASE_DEVICE_SESSION" && row.resource_id === a.student.id);
    assert.ok(audit);
    assert.equal(audit.admin_id, ids.admin);
    assert.equal(audit.metadata.reason, "Laptop crashed, moving to spare device");

    // The released device is rejected; the attempt continues on a new
    // device only after the student's own credentialed login.
    assert.equal((await call("GET", "/api/exam/current-question", { token: a.token })).status, 409);
    const replacement = await login(a.student);
    assert.equal(replacement.status, 200);
    res = await call("POST", "/api/exam/session/start", { token: replacement.body.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.session.id, a.sessionId, "same attempt continues");
    assert.equal((await call("POST", `${route}/release`, { token: adminToken(), body: { reason: "again" } })).status, 200);
    assert.equal((await call("POST", `${route}/release`, { token: adminToken(), body: { reason: "again" } })).status, 404);
    assert.equal((await call("GET", `/api/admin/candidates/${crypto.randomUUID()}/device-session`, { token: adminToken() })).body.deviceSession, null);
});

// ---------------------------------------------------------------------
// PRIORITY 9: edge cases
// ---------------------------------------------------------------------

test("A completed student who logs in again stays COMPLETED for admin monitoring", async () => {
    const a = await startExam();
    assert.equal((await call("POST", "/api/exam/session/submit", { token: a.token, body: { sessionId: a.sessionId } })).status, 200);
    const presence = () => tables.student_presence.find((row) => row.candidate_id === a.student.id);
    assert.equal(presence().stage, "COMPLETED");
    assert.equal((await call("POST", "/api/exam/auth/logout", { token: a.token })).status, 200);

    const again = await login(a.student);
    assert.equal(again.status, 200);
    assert.equal(presence().stage, "COMPLETED");
    const res = await call("POST", "/api/exam/presence", { token: again.body.token, body: { stage: "SYSTEM_CHECK" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, false);
    assert.equal(presence().stage, "COMPLETED");

    const dashboard = (await call("GET", "/api/admin/dashboard", { token: adminToken() })).body.dashboard;
    const listed = (await call("GET", `/api/admin/sessions?examId=${ids.exam}&limit=100`, { token: adminToken() })).body.sessions
        .find((row) => row.id === a.sessionId);
    assert.equal(listed.status, "SUBMITTED");
    assert.equal(listed.presence_stage, "COMPLETED");
    assert.ok(dashboard.sessionsSubmitted >= 1);
});

test("Answers before the deadline are saved; after it the attempt is finalized and the answer discarded", async () => {
    const a = await startExam();
    const row = sessionRow(a.sessionId);
    row.deadline_at = new Date(Date.now() + 5_000).toISOString();
    let current = (await call("GET", "/api/exam/current-question", { token: a.token })).body.question.id;
    let res = await call("POST", "/api/exam/answers", { token: a.token, body: { sessionId: a.sessionId, questionId: current, selectedOption: "B" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.autoSubmitted, false);
    current = res.body.nextQuestion.id;
    row.deadline_at = new Date(Date.now() - 1).toISOString();
    res = await call("POST", "/api/exam/answers", { token: a.token, body: { sessionId: a.sessionId, questionId: current, selectedOption: "C" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.autoSubmitted, true);
    assert.equal(row.status, "SUBMITTED");
    assert.equal(tables.exam_answers.filter((answer) => answer.session_id === a.sessionId).length, 1);
});

test("A server clock slightly ahead of the database does not fail the student with a 503", async () => {
    const a = await startExam();
    // This server believes the deadline passed; the database does not yet.
    sessionRow(a.sessionId).deadline_at = new Date(Date.now() - 500).toISOString();
    rpcOverrides.set("expire_exam_attempts", async () => ({ data: 0, error: null }));
    try {
        const res = await call("GET", "/api/exam/current-question", { token: a.token });
        assert.equal(res.status, 200);
        assert.equal(sessionRow(a.sessionId).status, "IN_PROGRESS");
    } finally { rpcOverrides.delete("expire_exam_attempts"); }
    const res = await call("GET", "/api/exam/current-question", { token: a.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.status, "SUBMITTED");
});
