// Real Express routes/middleware with isolated database doubles.
// No real Supabase keys, registration records or exam rows are accessed.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
process.env.STUDENT_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
const jwt = require("jsonwebtoken");
const { createMemorySupabase } = require("./helpers/memorySupabase");

const adminId = crypto.randomUUID();
const db = createMemorySupabase({
    exams: [{ id: crypto.randomUUID(), status: "ACTIVE", exam_code: "SESSION-TEST", exam_name: "Session Test", seconds_per_question: 60 }],
    exam_candidates: [], student_login_sessions: [], student_presence: [],
    admin_users: [{ id: adminId, is_active: true, role: "admin" }]
});
const registrationDb = createMemorySupabase({ registrations: [] });
for (const [file, client] of [["examSupabase.js", db], ["registrationSupabase.js", registrationDb]]) {
    const filename = path.join(__dirname, "..", "src", "config", file);
    require.cache[filename] = { id: filename, filename, loaded: true, exports: client };
}
const app = require("../src/server");
let server;
let baseUrl;
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

function candidate() {
    const id = crypto.randomUUID();
    const registrationId = `REG-${id}`;
    const hallTicketNumber = `HT-${id}`;
    registrationDb.db.tables.registrations.push({ id: crypto.randomUUID(), registration_id: registrationId,
        hall_ticket_number: hallTicketNumber, full_name: "Session Student", student_class: "10", payment_status: "SUCCESS" });
    db.db.tables.exam_candidates.push({ id, registration_id: registrationId, full_name: "Session Student", student_class: "10" });
    return { id, registrationId, hallTicketNumber };
}
async function call(route, { token, body, method = "POST" } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}
const login = (student, token) => call("/api/exam/auth/login", {
    token, body: { registrationId: student.registrationId, hallTicketNumber: student.hallTicketNumber }
});
const leaseFor = (student) => db.db.tables.student_login_sessions.find((row) => row.candidate_id === student.id);

test("Simultaneous logins permit one device; the rejected device cannot revoke the winner", async () => {
    const student = candidate();
    const results = await Promise.all([login(student), login(student)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200);
    const loser = results.find((r) => r.status === 409);
    assert.equal(loser.body.code, "SESSION_ACTIVE");
    assert.equal(loser.body.message, "Your exam is already active on another device.");
    assert.equal(loser.body.token, undefined);
    assert.equal(db.db.tables.student_login_sessions.filter((row) => row.candidate_id === student.id).length, 1);
    assert.equal(jwt.decode(winner.body.token).loginSessionId, leaseFor(student).login_session_id);
    assert.equal((await call("/api/exam/auth/heartbeat", { token: winner.body.token })).status, 200);
});

test("Refresh and signed-token relogin preserve the same lease and existing monitoring stage", async () => {
    const student = candidate();
    const first = await login(student);
    const leaseId = leaseFor(student).login_session_id;
    const presence = db.db.tables.student_presence.find((row) => row.candidate_id === student.id);
    presence.stage = "SYSTEM_CHECK";
    const resumed = await login(student, first.body.token);
    assert.equal(resumed.status, 200);
    assert.equal(leaseFor(student).login_session_id, leaseId);
    assert.equal(presence.stage, "SYSTEM_CHECK");
    assert.equal((await login(student)).status, 409);
});

test("Temporary disconnection renews a ten-minute grace without resetting the exam stage", async () => {
    const student = candidate();
    const first = await login(student);
    const lease = leaseFor(student);
    lease.last_seen_at = new Date(Date.now() - 180_000).toISOString();
    lease.expires_at = new Date(Date.now() + 420_000).toISOString();
    const presence = db.db.tables.student_presence.find((row) => row.candidate_id === student.id);
    presence.stage = "IN_EXAM";
    presence.updated_at = lease.last_seen_at;
    const heartbeat = await call("/api/exam/auth/heartbeat", { token: first.body.token });
    assert.equal(heartbeat.status, 200);
    assert.ok(Date.parse(heartbeat.body.expiresAt) - Date.now() > 590_000);
    assert.equal(presence.stage, "IN_EXAM");
    assert.ok(Date.now() - Date.parse(presence.updated_at) < 5_000);
});

test("Expired idle lease can recover on its original device before another device claims it", async () => {
    const student = candidate();
    const first = await login(student);
    const id = leaseFor(student).login_session_id;
    leaseFor(student).expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await call("/api/exam/auth/heartbeat", { token: first.body.token })).status, 409);
    assert.equal((await login(student, first.body.token)).status, 200);
    assert.equal(leaseFor(student).login_session_id, id);
    assert.equal((await login(student)).status, 409);
});

test("Idle cleanup permits a new device; the replaced token cannot return or release its lease", async () => {
    const student = candidate();
    const first = await login(student);
    const previousId = leaseFor(student).login_session_id;
    leaseFor(student).expires_at = new Date(Date.now() - 1000).toISOString();
    const next = await login(student);
    assert.equal(next.status, 200);
    assert.notEqual(leaseFor(student).login_session_id, previousId);
    assert.equal((await call("/api/exam/auth/heartbeat", { token: first.body.token })).status, 409);
    assert.equal((await login(student, first.body.token)).status, 409);
    assert.equal((await call("/api/exam/auth/logout", { token: first.body.token })).status, 200);
    assert.equal((await call("/api/exam/auth/heartbeat", { token: next.body.token })).status, 200);
});

test("JWT nearing expiry is renewed, while expired JWT recovery requires verified registration credentials", async () => {
    const student = candidate();
    await login(student);
    const lease = leaseFor(student);
    const claims = { candidateId: student.id, loginSessionId: lease.login_session_id, registrationId: student.registrationId, studentClass: "10", typ: "student" };
    const shortToken = jwt.sign(claims, process.env.STUDENT_JWT_SECRET, { algorithm: "HS256", expiresIn: "2m" });
    lease.token_expires_at = new Date(jwt.decode(shortToken).exp * 1000).toISOString();
    lease.expires_at = lease.token_expires_at;
    const heartbeat = await call("/api/exam/auth/heartbeat", { token: shortToken });
    assert.equal(heartbeat.status, 200);
    assert.ok(jwt.decode(heartbeat.body.token).exp > jwt.decode(shortToken).exp);
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.STUDENT_JWT_SECRET, { algorithm: "HS256" });
    assert.equal((await call("/api/exam/auth/heartbeat", { token: expired })).status, 401);
    const recovered = await login(student, expired);
    assert.equal(recovered.status, 200);
    assert.equal(jwt.decode(recovered.body.token).loginSessionId, lease.login_session_id);
    assert.equal((await login({ ...student, hallTicketNumber: "WRONG" }, expired)).status, 401);
});

test("Logout releases only the current device and immediately removes pre-exam online presence", async () => {
    const student = candidate();
    const first = await login(student);
    assert.equal((await call("/api/exam/auth/logout", { token: first.body.token })).status, 200);
    assert.equal(leaseFor(student), undefined);
    const presence = db.db.tables.student_presence.find((row) => row.candidate_id === student.id);
    assert.equal(presence.updated_at, "1970-01-01T00:00:00.000Z");
    assert.equal((await call("/api/exam/auth/heartbeat", { token: first.body.token })).status, 409);
    assert.equal((await login(student)).status, 200);
});

test("Stateless legacy and mismatched-device tokens cannot bypass session validation", async () => {
    const student = candidate();
    await login(student);
    const legacy = jwt.sign({ candidateId: student.id, typ: "student" }, process.env.STUDENT_JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await call("/api/exam/auth/heartbeat", { token: legacy })).status, 401);
    const mismatch = jwt.sign({ candidateId: student.id, loginSessionId: crypto.randomUUID(), typ: "student" }, process.env.STUDENT_JWT_SECRET, { expiresIn: "1h" });
    assert.equal((await call("/api/exam/auth/heartbeat", { token: mismatch })).status, 409);
});

test("Session database errors fail closed and report a retryable outage", async () => {
    const student = candidate();
    const first = await login(student);
    const originalRpc = db.rpc;
    try {
        db.rpc = async () => ({ data: null, error: { message: "simulated database outage" } });
        const response = await call("/api/exam/auth/heartbeat", { token: first.body.token });
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "SESSION_UNAVAILABLE");
    } finally { db.rpc = originalRpc; }
});

test("Admin monitoring remains available with device leases and completed presence", async () => {
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const dashboard = await call("/api/admin/dashboard", { token, method: "GET" });
    assert.equal(dashboard.status, 200);
    assert.ok(Number.isInteger(dashboard.body.dashboard.totalCandidates));
    const student = candidate();
    const first = await login(student);
    const presence = db.db.tables.student_presence.find((row) => row.candidate_id === student.id);
    presence.stage = "COMPLETED";
    assert.equal((await call("/api/exam/auth/logout", { token: first.body.token })).status, 200);
    assert.equal(presence.stage, "COMPLETED");
    assert.ok(Date.now() - Date.parse(presence.updated_at) < 5_000);
});

test("Admin disconnected count uses heartbeat even when no recent answer was submitted", async () => {
    const student = candidate();
    await login(student);
    const stale = new Date(Date.now() - 300_000).toISOString();
    const session = { id: crypto.randomUUID(), candidate_id: student.id, exam_id: db.db.tables.exams[0].id,
        status: "IN_PROGRESS", last_activity_at: stale, proctoring_warning_count: 0 };
    (db.db.tables.exam_sessions ||= []).push(session);
    const presence = db.db.tables.student_presence.find((row) => row.candidate_id === student.id);
    presence.stage = "IN_EXAM";
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const connected = await call("/api/admin/dashboard", { token, method: "GET" });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.dashboard.sessionsDisconnected, 0);
    presence.updated_at = stale;
    const disconnected = await call("/api/admin/dashboard", { token, method: "GET" });
    assert.equal(disconnected.body.dashboard.sessionsDisconnected, 1);
    session.status = "SUBMITTED";
});

test("Admin answer detail retains the attempt's frozen marks and correctness after bank edits", async () => {
    const student = candidate();
    const questionId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    (db.db.tables.questions ||= []).push({ id: questionId, question_number: 99, marks: 99, correct_option: "D" });
    (db.db.tables.exam_sessions ||= []).push({ id: sessionId, candidate_id: student.id, exam_id: db.db.tables.exams[0].id,
        status: "SUBMITTED", sequence_initialized_at: new Date().toISOString(), total_score: 2, max_score: 2 });
    (db.db.tables.exam_attempt_questions ||= []).push({ session_id: sessionId, question_id: questionId,
        position: 0, question_number: 1, marks: 2, correct_option: "B" });
    (db.db.tables.exam_answers ||= []).push({ session_id: sessionId, question_id: questionId,
        selected_option: "B", is_attempted: true, is_correct: false });
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const result = await call(`/api/admin/sessions/${sessionId}/result`, { token, method: "GET" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.answers[0].questions, { question_number: 1, marks: 2 });
    assert.equal(result.body.answers[0].is_correct, true);
    assert.equal(result.body.session.total_score, 2);
    assert.doesNotMatch(JSON.stringify(result.body), /correct_option/);
});
