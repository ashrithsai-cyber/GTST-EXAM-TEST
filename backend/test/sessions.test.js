// Real Express routes/middleware with isolated database doubles.
// No real Supabase keys, registration records or exam rows are accessed.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const ExcelJS = require("exceljs");
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
    assert.equal(dashboard.body.dashboard.currentlyLoggedIn, dashboard.body.dashboard.totalCandidates);
    const student = candidate();
    const first = await login(student);
    const presence = db.db.tables.student_presence.find((row) => row.candidate_id === student.id);
    presence.stage = "COMPLETED";
    assert.equal((await call("/api/exam/auth/logout", { token: first.body.token })).status, 200);
    assert.equal(presence.stage, "COMPLETED");
    assert.ok(Date.now() - Date.parse(presence.updated_at) < 5_000);
});

test("Missing monitoring migration leaves student sessions and warning totals available", async (t) => {
    const student = candidate();
    const sessionId = crypto.randomUUID();
    (db.db.tables.exam_sessions ||= []).push({
        id: sessionId, candidate_id: student.id, exam_id: db.db.tables.exams[0].id,
        status: "IN_PROGRESS", proctoring_warning_count: 4, last_activity_at: new Date().toISOString()
    });
    const originalRpc = db.rpc.bind(db);
    t.mock.method(db, "rpc", async (name, args) => {
        if (["admin_exam_attempt_progress", "admin_monitoring_event_summary"].includes(name)) {
            return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } };
        }
        return originalRpc(name, args);
    });
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await call("/api/admin/sessions", { token, method: "GET" });
    assert.equal(response.status, 200);
    const session = response.body.sessions.find(row => row.id === sessionId);
    assert.equal(session.proctoring_warning_count, 4);
    assert.equal(session.attempt_progress, null);
    assert.match(response.body.monitoringWarning, /021_admin_monitoring_summary.sql/);
    const summary = await call("/api/admin/proctoring/event-summaries", { token, body: { sessionIds: [sessionId] } });
    assert.equal(summary.status, 503);
    assert.equal(summary.body.code, "MONITORING_MIGRATION_REQUIRED");
    assert.equal(db.db.tables.exam_sessions.find(row => row.id === sessionId).status, "IN_PROGRESS");
});

test("Monitoring database outages are reported instead of mistaken for missing optional summaries", async (t) => {
    t.mock.method(db, "rpc", async () => ({ data: null, error: { code: "08006", message: "connection failure" } }));
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const sessions = await call("/api/admin/sessions", { token, method: "GET" });
    assert.equal(sessions.status, 500);
    const summaries = await call("/api/admin/proctoring/event-summaries", { token, body: { sessionIds: [crypto.randomUUID()] } });
    assert.equal(summaries.status, 500);
    assert.notEqual(summaries.body.code, "MONITORING_MIGRATION_REQUIRED");
});

test("Monitoring summaries remain admin-only", async () => {
    const response = await call("/api/admin/proctoring/event-summaries", { body: { sessionIds: [crypto.randomUUID()] } });
    assert.equal(response.status, 401);
});

test("Admin dashboard class activity is scoped to the active exam and eligible candidates", async () => {
    const activeExamId = db.db.tables.exams.find((row) => row.status === "ACTIVE").id;
    const inactiveExamId = crypto.randomUUID();
    db.db.tables.exams.push({ id: inactiveExamId, status: "INACTIVE", exam_code: "OLD-TEST", exam_name: "Old Test", seconds_per_question: 60 });
    const activeStudent = candidate();
    const inactiveStudent = candidate();
    const activeRow = db.db.tables.exam_candidates.find((row) => row.id === activeStudent.id);
    const inactiveRow = db.db.tables.exam_candidates.find((row) => row.id === inactiveStudent.id);
    activeRow.student_class = "Dashboard Active Scope";
    inactiveRow.student_class = "Dashboard Inactive Scope";
    (db.db.tables.exam_sessions ||= []).push(
        { id: crypto.randomUUID(), candidate_id: activeStudent.id, exam_id: activeExamId, status: "IN_PROGRESS", proctoring_warning_count: 0 },
        { id: crypto.randomUUID(), candidate_id: inactiveStudent.id, exam_id: inactiveExamId, status: "SUBMITTED", proctoring_warning_count: 0 }
    );
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await call("/api/admin/dashboard", { token, method: "GET" });
    assert.equal(response.status, 200);
    const activeBreakdown = response.body.dashboard.classBreakdown.find((row) => row.studentClass === "Dashboard Active Scope");
    assert.equal(activeBreakdown.present, 1);
    assert.equal(activeBreakdown.ongoing, 1);
    assert.equal(response.body.dashboard.classBreakdown.some((row) => row.studentClass === "Dashboard Inactive Scope"), false);
    assert.ok(response.body.dashboard.eligibleCandidates >= 2);
});

test("Admin dashboard exam and date filters return bounded daily submission and score trends", async () => {
    const examId = crypto.randomUUID();
    db.db.tables.exams.push({
        id: examId, status: "INACTIVE", exam_code: "TREND-TEST",
        exam_name: "Trend Test", seconds_per_question: 60
    });
    const included = candidate();
    const outsideRange = candidate();
    (db.db.tables.exam_sessions ||= []).push(
        { id: crypto.randomUUID(), candidate_id: included.id, exam_id: examId, status: "SUBMITTED",
            submitted_at: "2026-09-03T12:00:00.000Z", total_score: 3, max_score: 4 },
        { id: crypto.randomUUID(), candidate_id: outsideRange.id, exam_id: examId, status: "SUBMITTED",
            submitted_at: "2026-09-02T12:00:00.000Z", total_score: 0, max_score: 4 }
    );
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await call(`/api/admin/dashboard?examId=${examId}&from=2026-09-03&to=2026-09-04`, { token, method: "GET" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.dashboard.selectedExam, { id: examId, name: "Trend Test", status: "INACTIVE" });
    assert.deepEqual(response.body.dashboard.dailyTrend, [
        { date: "2026-09-03", submissions: 1, averageScorePercent: 75 },
        { date: "2026-09-04", submissions: 0, averageScorePercent: null }
    ]);
    assert.equal(response.body.dashboard.sessionsSubmitted, 2);
});

test("Admin dashboard rejects malformed and overlong trend filters", async () => {
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const malformed = await call("/api/admin/dashboard?examId=bad", { token, method: "GET" });
    assert.equal(malformed.status, 400);
    const tooLong = await call("/api/admin/dashboard?from=2026-01-01&to=2026-04-01", { token, method: "GET" });
    assert.equal(tooLong.status, 400);
});

test("Admin result search filters all submissions before pagination", async () => {
    const activeExamId = db.db.tables.exams.find((row) => row.status === "ACTIVE").id;
    const firstStudent = candidate();
    const matchingStudent = candidate();
    const matchingRegistration = matchingStudent.registrationId;
    const now = Date.now();
    (db.db.tables.exam_sessions ||= []).push(
        { id: crypto.randomUUID(), candidate_id: firstStudent.id, exam_id: activeExamId, status: "SUBMITTED", submitted_at: new Date(now).toISOString(), total_score: 1, max_score: 2 },
        { id: crypto.randomUUID(), candidate_id: matchingStudent.id, exam_id: activeExamId, status: "SUBMITTED", submitted_at: new Date(now - 60_000).toISOString(), total_score: 2, max_score: 2 }
    );
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await call(`/api/admin/results?page=1&limit=1&search=${encodeURIComponent(matchingRegistration)}`, { token, method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].exam_candidates.registration_id, matchingRegistration);
});

test("Admin result CSV export includes the full filtered dataset and neutralizes spreadsheet formulas", async () => {
    const activeExamId = db.db.tables.exams.find((row) => row.status === "ACTIVE").id;
    const matchingStudent = candidate();
    db.db.tables.exam_candidates.find((row) => row.id === matchingStudent.id).full_name = "=HYPERLINK(\"https://example.invalid\")";
    const otherStudent = candidate();
    (db.db.tables.exam_sessions ||= []).push(
        { id: crypto.randomUUID(), candidate_id: matchingStudent.id, exam_id: activeExamId, status: "SUBMITTED", submitted_at: new Date().toISOString(), total_score: 1, max_score: 2 },
        { id: crypto.randomUUID(), candidate_id: otherStudent.id, exam_id: activeExamId, status: "SUBMITTED", submitted_at: new Date(Date.now() - 60_000).toISOString(), total_score: 2, max_score: 2 }
    );
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`${baseUrl}/api/admin/results/export.csv?search=${encodeURIComponent(matchingStudent.registrationId)}`, {
        headers: { Authorization: "Bearer " + token }
    });
    const csv = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/csv/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
    assert.doesNotMatch(csv, new RegExp(otherStudent.registrationId));
});

test("Admin result XLSX export applies exam, class, and date filters", async () => {
    const examId = db.db.tables.exams[0].id;
    const included = candidate();
    const excluded = candidate();
    db.db.tables.exam_candidates.find((row) => row.id === included.id).student_class = "10";
    db.db.tables.exam_candidates.find((row) => row.id === excluded.id).student_class = "9";
    const submittedAt = new Date("2026-09-03T12:00:00.000Z").toISOString();
    (db.db.tables.exam_sessions ||= []).push(
        { id: crypto.randomUUID(), candidate_id: included.id, exam_id: examId, status: "SUBMITTED", submitted_at: submittedAt, total_score: 3, max_score: 4 },
        { id: crypto.randomUUID(), candidate_id: excluded.id, exam_id: examId, status: "SUBMITTED", submitted_at: submittedAt, total_score: 1, max_score: 4 }
    );
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`${baseUrl}/api/admin/results/export.xlsx?examId=${examId}&className=10&from=2026-09-03&to=2026-09-03&search=${encodeURIComponent(included.registrationId)}`, {
        headers: { Authorization: "Bearer " + token }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /spreadsheetml/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const sheet = workbook.getWorksheet("Results");
    assert.equal(sheet.rowCount, 2);
    assert.equal(sheet.getRow(2).getCell(2).value, included.registrationId);
});

test("Admin violation XLSX export applies filters and omits connectivity telemetry", async () => {
    const student = candidate();
    const examId = db.db.tables.exams[0].id;
    const sessionId = crypto.randomUUID();
    db.db.tables.exam_sessions ||= [];
    db.db.tables.exam_sessions.push({
        id: sessionId, candidate_id: student.id, exam_id: examId, status: "SUBMITTED"
    });
    const at = "2026-10-10T12:00:00.000Z";
    db.db.tables.exam_events ||= [];
    db.db.tables.exam_events.push(
        { id: crypto.randomUUID(), session_id: sessionId, event_type: "CAMERA_DISABLED", event_message: "camera", created_at: at, reviewed: false, is_violation: true },
        { id: crypto.randomUUID(), session_id: sessionId, event_type: "NETWORK_DISCONNECT", event_message: "offline", created_at: at, reviewed: false, is_violation: false },
        { id: crypto.randomUUID(), session_id: sessionId, event_type: "TAB_SWITCH", event_message: "outside date", created_at: "2026-10-09T12:00:00.000Z", reviewed: false, is_violation: true }
    );
    const token = jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
    const response = await fetch(`${baseUrl}/api/admin/proctoring/events/export.xlsx?examId=${examId}&className=10&from=2026-10-10&to=2026-10-10&reviewed=false`, {
        headers: { Authorization: "Bearer " + token }
    });
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const sheet = workbook.getWorksheet("Proctoring Violations");
    assert.equal(sheet.rowCount, 2);
    assert.equal(sheet.getRow(2).getCell(6).value, "CAMERA_DISABLED");
});

test("Results and violation exports require an authenticated admin", async () => {
    for (const route of [
        "/api/admin/results/export.csv", "/api/admin/results/export.xlsx",
        "/api/admin/proctoring/events/export.csv", "/api/admin/proctoring/events/export.xlsx"
    ]) {
        const response = await fetch(`${baseUrl}${route}`);
        assert.equal(response.status, 401, route);
    }
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
