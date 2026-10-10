// End-to-end security tests for the exam API. Runs the real Express app,
// middleware and controllers against an in-memory database double
// (helpers/memorySupabase.js), so nothing here ever touches a real
// Supabase project. Run with `npm test` from backend/.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");

// Test-only secrets, set before the app (and dotenv) load so the real
// backend/.env can never be picked up for these.
process.env.STUDENT_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";

const jwt = require("jsonwebtoken");
const { createMemorySupabase } = require("./helpers/memorySupabase");

const ids = {
    examA: crypto.randomUUID(),
    examB: crypto.randomUUID(),
    classA: crypto.randomUUID(),
    classB: crypto.randomUUID(),
    subjectA1: crypto.randomUUID(),
    subjectB1: crypto.randomUUID(),
    qA1: crypto.randomUUID(),
    qA2: crypto.randomUUID(),
    qA3: crypto.randomUUID(),
    qB1: crypto.randomUUID(),
    studentA: crypto.randomUUID(),
    studentB: crypto.randomUUID(),
    admin: crypto.randomUUID()
};

const now = new Date().toISOString();
const seed = {
    exams: [
        { id: ids.examA, exam_code: "EXAM-A", exam_name: "Exam A", status: "ACTIVE", seconds_per_question: 60, created_at: "2026-01-01T00:00:00.000Z", exam_start_at: null, duration_minutes: null, results_published: false },
        { id: ids.examB, exam_code: "EXAM-B", exam_name: "Exam B", status: "INACTIVE", seconds_per_question: 30, created_at: "2026-01-02T00:00:00.000Z", exam_start_at: null, duration_minutes: null, results_published: false }
    ],
    classes: [
        { id: ids.classA, exam_id: ids.examA, class_name: "Class 10", display_order: 1 },
        { id: ids.classB, exam_id: ids.examB, class_name: "Class 10", display_order: 1 }
    ],
    subjects: [
        { id: ids.subjectA1, class_id: ids.classA, subject_key: "maths", subject_name: "Mathematics A", display_order: 1 },
        { id: ids.subjectB1, class_id: ids.classB, subject_key: "maths", subject_name: "Mathematics B", display_order: 1 }
    ],
    questions: [
        { id: ids.qA1, subject_id: ids.subjectA1, question_number: 1, question_text: "A1?", passage: null, option_a: "1", option_b: "2", option_c: "3", option_d: "4", correct_option: "B", marks: 2 },
        { id: ids.qA2, subject_id: ids.subjectA1, question_number: 2, question_text: "A2?", passage: null, option_a: "1", option_b: "2", option_c: "3", option_d: "4", correct_option: "C", marks: 2 },
        { id: ids.qA3, subject_id: ids.subjectA1, question_number: 3, question_text: "A3?", passage: null, option_a: "1", option_b: "2", option_c: "3", option_d: "4", correct_option: "D", marks: 2 },
        { id: ids.qB1, subject_id: ids.subjectB1, question_number: 1, question_text: "B1?", passage: null, option_a: "1", option_b: "2", option_c: "3", option_d: "4", correct_option: "A", marks: 5 }
    ],
    exam_candidates: [
        { id: ids.studentA, registration_id: "REG-A", full_name: "Student A", student_class: "10", hall_ticket_number: "HT-A" },
        { id: ids.studentB, registration_id: "REG-B", full_name: "Student B", student_class: "10", hall_ticket_number: "HT-B" }
    ],
    admin_users: [
        { id: ids.admin, name: "Admin", email: "admin@example.invalid", password_hash: "x", role: "admin", is_active: true, created_at: now }
    ]
};

const db = createMemorySupabase(seed);
const registrationDb = createMemorySupabase({ registrations: [] });

// Swap both Supabase clients for the in-memory double before the app loads.
const configDir = path.join(__dirname, "..", "src", "config");
for (const [file, client] of [["examSupabase.js", db], ["registrationSupabase.js", registrationDb]]) {
    const resolved = path.join(configDir, file);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: client };
}

const app = require("../src/server");

let server;
let baseUrl;

test.before(async () => {
    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

const studentToken = (candidateId) => {
    const sessions = db.db.tables.student_login_sessions ||= [];
    let lease = sessions.find((row) => row.candidate_id === candidateId);
    if (!lease) {
        lease = { candidate_id: candidateId, login_session_id: crypto.randomUUID(),
            created_at: now, last_seen_at: now,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            token_expires_at: new Date(Date.now() + 3_600_000).toISOString() };
        sessions.push(lease);
    }
    return jwt.sign({ candidateId, registrationId: "REG", studentClass: "10", typ: "student", loginSessionId: lease.login_session_id },
        process.env.STUDENT_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
};
const adminToken = (adminId = ids.admin) =>
    jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

async function call(method, route, { token, body, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
        payload = form;
    } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, body: json, text };
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);

function photoForm(bytes = JPEG_BYTES, type = "image/jpeg") {
    const form = new FormData();
    form.append("screenshot", new Blob([bytes], { type }), "system-check.jpg");
    return form;
}

const ALL_CHECKS = { camera: true, microphone: true, fullscreen: true, face: true };

async function completePreflight(token) {
    assert.equal((await call("POST", "/api/exam/system-check/screenshot", { token, form: photoForm() })).status, 200);
    assert.equal((await call("POST", "/api/exam/preflight/system-check", { token, body: ALL_CHECKS })).status, 200);
    assert.equal((await call("POST", "/api/exam/preflight/rules-accepted", { token })).status, 200);
}

const sessionRow = (id) => db.db.tables.exam_sessions.find((s) => s.id === id);

// ---------------------------------------------------------------------

const tokenA = studentToken(ids.studentA);
const tokenB = studentToken(ids.studentB);
let sessionA;
let sessionB;

test("Test 3: session start is refused (403) until the server-side preflight is complete", async () => {
    let res = await call("POST", "/api/exam/session/start", { token: tokenA });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "PREFLIGHT_REQUIRED");
    assert.match(res.body.message, /System check must be completed/);

    // A forged "all passed" system check without a real check-in photo.
    res = await call("POST", "/api/exam/preflight/system-check", { token: tokenA, body: ALL_CHECKS });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CHECK_IN_PHOTO_REQUIRED");

    // Required check reported as failing.
    res = await call("POST", "/api/exam/preflight/system-check", { token: tokenA, body: { ...ALL_CHECKS, microphone: false } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SYSTEM_CHECK_INCOMPLETE");

    // Rules cannot be accepted before a system check.
    res = await call("POST", "/api/exam/preflight/rules-accepted", { token: tokenA });
    assert.equal(res.status, 403);

    // Photo + system check, but rules not accepted yet.
    assert.equal((await call("POST", "/api/exam/system-check/screenshot", { token: tokenA, form: photoForm() })).status, 200);
    assert.equal((await call("POST", "/api/exam/preflight/system-check", { token: tokenA, body: ALL_CHECKS })).status, 200);
    res = await call("POST", "/api/exam/session/start", { token: tokenA });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "RULES_NOT_ACCEPTED");

    assert.equal((await call("POST", "/api/exam/preflight/rules-accepted", { token: tokenA })).status, 200);
    res = await call("POST", "/api/exam/session/start", { token: tokenA });
    assert.equal(res.status, 200);
    assert.equal(res.body.exam.id, ids.examA);
    sessionA = res.body.session.id;
    assert.equal(sessionRow(sessionA).seconds_per_question, 60, "timer is snapshotted on the session");

    await completePreflight(tokenB);
    res = await call("POST", "/api/exam/session/start", { token: tokenB });
    assert.equal(res.status, 200);
    sessionB = res.body.session.id;
});

test("Screenshot upload rejects non-image content and spoofed MIME types", async () => {
    let res = await call("POST", "/api/exam/system-check/screenshot", { token: tokenA, form: photoForm(Buffer.from("<script>alert(1)</script>"), "image/jpeg") });
    assert.equal(res.status, 400);
    res = await call("POST", "/api/exam/system-check/screenshot", { token: tokenA, form: photoForm(JPEG_BYTES, "text/html") });
    assert.equal(res.status, 400);
});

test("Test 7: the student never receives the answer key", async () => {
    const res = await call("GET", "/api/exam/current-question", { token: tokenA });
    assert.equal(res.status, 200);
    assert.equal(res.body.question.id, ids.qA1);
    assert.doesNotMatch(res.text, /correct_option|correctOption|is_correct|isCorrect/);

    const info = await call("GET", "/api/exam/info", { token: tokenA });
    assert.doesNotMatch(info.text, /correct|question_text|option_a/i);
});

test("Test 1 + 6: Student A cannot use Student B's session (403)", async () => {
    let res = await call("POST", "/api/exam/answers", { token: tokenA, body: { sessionId: sessionB, questionId: ids.qA1, selectedOption: "B" } });
    assert.equal(res.status, 403);
    res = await call("GET", `/api/exam/answers/${sessionB}`, { token: tokenA });
    assert.equal(res.status, 403);
    res = await call("POST", "/api/exam/session/submit", { token: tokenA, body: { sessionId: sessionB } });
    assert.equal(res.status, 403);
    res = await call("POST", "/api/exam/proctoring/event", { token: tokenA, body: { sessionId: sessionB, eventType: "TAB_SWITCH" } });
    assert.equal(res.status, 403);
    assert.equal(sessionRow(sessionB).status, "IN_PROGRESS");
    assert.equal(sessionRow(sessionB).proctoring_warning_count ?? 0, 0);
    assert.equal((db.db.tables.exam_answers || []).filter((a) => a.session_id === sessionB).length, 0);
});

test("Test 5: admin activating another exam never moves an in-progress student", async () => {
    // Student A answers question 1 of Exam A.
    let res = await call("POST", "/api/exam/answers", { token: tokenA, body: { sessionId: sessionA, questionId: ids.qA1, selectedOption: "B" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.nextQuestion.id, ids.qA2);

    // Admin activates Exam B mid-exam.
    res = await call("PATCH", `/api/admin/exams/${ids.examB}/status`, { token: adminToken(), body: { status: "ACTIVE" } });
    assert.equal(res.status, 200);
    assert.equal(db.db.tables.exams.find((e) => e.id === ids.examA).status, "INACTIVE");

    // Refresh/resume, current question, exam info: all still Exam A.
    res = await call("POST", "/api/exam/session/start", { token: tokenA });
    assert.equal(res.status, 200);
    assert.equal(res.body.session.id, sessionA);
    assert.equal(res.body.exam.id, ids.examA);
    assert.equal(res.body.exam.secondsPerQuestion, 60, "Exam A's timer, not Exam B's 30s");

    res = await call("GET", "/api/exam/current-question", { token: tokenA });
    assert.equal(res.body.exam.id, ids.examA);
    assert.equal(res.body.question.id, ids.qA2);

    res = await call("GET", "/api/exam/info", { token: tokenA });
    assert.equal(res.body.exam.id, ids.examA);
    assert.equal(res.body.subjects[0].subjectName, "Mathematics A");

    // Next question + answer are stored against Exam A.
    res = await call("POST", "/api/exam/answers", { token: tokenA, body: { sessionId: sessionA, questionId: ids.qA2, selectedOption: "A" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.remainingSeconds, 60);
    const answers = db.db.tables.exam_answers.filter((a) => a.session_id === sessionA);
    assert.deepEqual(answers.map((a) => a.question_id).sort(), [ids.qA1, ids.qA2].sort());
    assert.equal(db.db.tables.exam_sessions.filter((s) => s.candidate_id === ids.studentA).length, 1, "no Exam B session was created");
});

test("Duplicate/replayed answers cannot overwrite a locked-in answer", async () => {
    const res = await call("POST", "/api/exam/answers", { token: tokenA, body: { sessionId: sessionA, questionId: ids.qA1, selectedOption: "D" } });
    assert.equal(res.status, 409);
    const a1 = db.db.tables.exam_answers.find((a) => a.session_id === sessionA && a.question_id === ids.qA1);
    assert.equal(a1.selected_option, "B");
});

test("Test 4: a late answer is rejected by the server clock regardless of the client timer", async () => {
    sessionRow(sessionA).question_started_at = new Date(Date.now() - 120 * 1000).toISOString();
    const res = await call("POST", "/api/exam/answers", {
        token: tokenA,
        body: { sessionId: sessionA, questionId: ids.qA3, selectedOption: "D", timeSpentSeconds: 5 }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.timedOut, true);
    const a3 = db.db.tables.exam_answers.find((a) => a.session_id === sessionA && a.question_id === ids.qA3);
    assert.equal(a3.selected_option, null, "late answer discarded even though it was correct");
    assert.equal(res.body.examComplete, true);
});

test("Results stay hidden until an admin publishes them; scoring is server-side", async () => {
    let res = await call("POST", "/api/exam/session/submit", { token: tokenA, body: { sessionId: sessionA } });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalScore, undefined, "no score in the submit response");
    const row = sessionRow(sessionA);
    assert.equal(row.status, "SUBMITTED");
    assert.equal(row.exam_id, ids.examA);
    assert.equal(row.total_score, 2, "only Q1 (B) correct: 2 marks");
    assert.equal(row.max_score, 6);

    res = await call("GET", "/api/exam/result", { token: tokenA });
    assert.equal(res.body.published, false);
    assert.equal(res.body.result, undefined);

    res = await call("PATCH", `/api/admin/exams/${ids.examA}/results-publication`, { token: adminToken(), body: { published: true } });
    assert.equal(res.status, 200);

    res = await call("GET", "/api/exam/result", { token: tokenA });
    assert.equal(res.body.published, true);
    assert.deepEqual(
        { score: res.body.result.totalScore, max: res.body.result.maxScore, correct: res.body.result.correctAnswers, wrong: res.body.result.wrongAnswers, unanswered: res.body.result.unanswered },
        { score: 2, max: 6, correct: 1, wrong: 1, unanswered: 1 }
    );
    assert.doesNotMatch(res.text, /correct_option|selected_option/);
});

test("Test 2: student tokens are rejected on admin routes; admin tokens on student routes", async () => {
    for (const route of ["/api/admin/dashboard", "/api/admin/exams", "/api/admin/results", `/api/admin/sessions/${sessionB}/result`]) {
        const res = await call("GET", route, { token: tokenA });
        assert.equal(res.status, 401, route);
    }
    assert.equal((await call("GET", "/api/admin/exams")).status, 401, "no token");
    assert.equal((await call("GET", "/api/exam/current-question", { token: adminToken() })).status, 401);

    // Even with a shared secret, a token's type claim is enforced.
    const forged = jwt.sign({ candidateId: ids.studentA, typ: "admin", adminId: ids.admin }, process.env.STUDENT_JWT_SECRET, { algorithm: "HS256" });
    assert.equal((await call("GET", "/api/exam/current-question", { token: forged })).status, 401);
    const noneAlg = jwt.sign({ adminId: ids.admin, typ: "admin" }, "", { algorithm: "none" });
    assert.equal((await call("GET", "/api/admin/exams", { token: noneAlg })).status, 401);
});

test("Test 8: students have no route to any screenshot; admin access only", async () => {
    const shot = db.db.tables.system_check_screenshots.find((s) => s.candidate_id === ids.studentB);
    assert.ok(shot);
    assert.equal((await call("GET", `/api/admin/system-check-screenshots/${shot.id}/image`, { token: tokenA })).status, 401);
    assert.equal((await call("GET", "/api/admin/system-check-screenshots", { token: tokenA })).status, 401);
    const adminRes = await fetch(`${baseUrl}/api/admin/system-check-screenshots/${shot.id}/image`, { headers: { Authorization: `Bearer ${adminToken()}` } });
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.headers.get("content-type"), "image/jpeg");
    assert.match(adminRes.headers.get("cache-control"), /private/);
});

test("Test 9: deactivating an admin revokes their existing token immediately", async () => {
    const other = crypto.randomUUID();
    db.db.tables.admin_users.push({ id: other, name: "Other", email: "other@example.invalid", password_hash: "x", role: "admin", is_active: true });
    const token = adminToken(other);
    assert.equal((await call("GET", "/api/admin/exams", { token })).status, 200);
    const res = await call("PATCH", `/api/admin/users/${other}/status`, { token: adminToken(), body: { isActive: false } });
    assert.equal(res.status, 200);
    assert.equal((await call("GET", "/api/admin/exams", { token })).status, 401);
});

// GTST policy: once a student starts, the attempt's deadline is the
// snapshot taken when it was initialized (exam_sessions.deadline_at, see
// 017_sequential_attempts.sql). An admin later editing or shortening the
// exam window applies to attempts started afterwards; it never shortens
// or extends an attempt that is already running. The snapshot deadline
// itself is enforced by the server clock, regardless of the browser.
test("Test 10: a running attempt keeps its snapshot deadline, which closes it server-side", async () => {
    // Student B is still in Exam A; the admin now schedules Exam A's
    // window to have ended. B's running attempt must not change.
    const examA = db.db.tables.exams.find((e) => e.id === ids.examA);
    const snapshotDeadline = sessionRow(sessionB).deadline_at;
    examA.exam_start_at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    examA.duration_minutes = 60;

    let res = await call("GET", "/api/exam/current-question", { token: tokenB });
    assert.equal(res.status, 200, "an admin window change does not close a running attempt");
    assert.equal(sessionRow(sessionB).status, "IN_PROGRESS");
    assert.equal(sessionRow(sessionB).deadline_at, snapshotDeadline, "the attempt deadline is not recomputed");
    assert.equal(res.body.examTiming.examEndAt, snapshotDeadline);

    // The attempt's own snapshot deadline passes: the server closes it.
    sessionRow(sessionB).deadline_at = new Date(Date.now() - 1000).toISOString();
    res = await call("POST", "/api/exam/answers", { token: tokenB, body: { sessionId: sessionB, questionId: ids.qA1, selectedOption: "B" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.autoSubmitted, true);
    assert.equal(sessionRow(sessionB).status, "SUBMITTED");
    assert.equal((db.db.tables.exam_answers || []).filter((a) => a.session_id === sessionB).length, 0, "answer after the deadline not stored");

    res = await call("GET", "/api/exam/current-question", { token: tokenB });
    assert.equal(res.status, 403);
    assert.equal(res.body.status, "SUBMITTED");
});

test("Structural question-bank edits are blocked while a class has live sessions", async () => {
    const tokenC = studentToken(ids.studentA); // Student A already submitted Exam A; start Exam B.
    const examB = db.db.tables.exams.find((e) => e.id === ids.examB);
    assert.equal(examB.status, "ACTIVE");
    await completePreflight(tokenC);
    const res = await call("POST", "/api/exam/session/start", { token: tokenC });
    assert.equal(res.status, 200);
    assert.equal(res.body.exam.id, ids.examB);

    const add = await call("POST", `/api/admin/subjects/${ids.subjectB1}/questions`, {
        token: adminToken(),
        // A valid, unused question number, so the request passes field
        // validation and reaches the live-session protection under test.
        body: { questionNumber: 2, questionText: "Inserted", optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctOption: "A" }
    });
    assert.equal(add.status, 409);
    assert.match(add.body.message, /currently taking this exam/);
    assert.equal(db.db.tables.questions.filter((q) => q.subject_id === ids.subjectB1).length, 1, "no question was inserted");
    assert.equal((await call("DELETE", `/api/admin/questions/${ids.qB1}`, { token: adminToken() })).status, 409);
    // Editing content is still allowed.
    assert.equal((await call("PUT", `/api/admin/questions/${ids.qB1}`, { token: adminToken(), body: { questionText: "B1 (fixed typo)?" } })).status, 200);
});

test("Malformed ids and bodies never produce a 500", async () => {
    assert.equal((await call("GET", "/api/admin/exams/not-a-uuid", { token: adminToken() })).status, 404);
    assert.equal((await call("POST", "/api/exam/answers", { token: tokenA, body: { sessionId: "x", questionId: "y" } })).status, 400);
    const res = await fetch(`${baseUrl}/api/exam/answers`, { method: "POST", headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.stack, undefined);
});
