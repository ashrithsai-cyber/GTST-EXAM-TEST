// Student login matches Registration ID + Hall Ticket Number ignoring
// letter case and spaces, through the real Express route with isolated
// database doubles. No real Supabase keys or registration records are used.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
process.env.STUDENT_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
const { createMemorySupabase } = require("./helpers/memorySupabase");

const db = createMemorySupabase({
    exams: [{ id: crypto.randomUUID(), status: "ACTIVE", exam_code: "CASE-TEST", exam_name: "Case Test", seconds_per_question: 60 }],
    exam_candidates: [], student_login_sessions: [], student_presence: []
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

// Same shapes as the real registrations table: "GTST26100094" and
// "GTS/ABCDEF123ABC12345" — stored in upper case.
let serial = 100;
function registration({ paymentStatus = "SUCCESS", registrationId, hallTicketNumber } = {}) {
    serial += 1;
    const row = { id: crypto.randomUUID(), registration_id: registrationId ?? `GTST26100${serial}`,
        hall_ticket_number: hallTicketNumber ?? `GTS/HYDABC${serial}KLM26${serial}`, full_name: "Case Student",
        student_class: "10", payment_status: paymentStatus };
    registrationDb.db.tables.registrations.push(row);
    return row;
}
async function login(registrationId, hallTicketNumber) {
    const response = await fetch(`${baseUrl}/api/exam/auth/login`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationId, hallTicketNumber }) });
    return { status: response.status, body: await response.json() };
}
const mixed = (value) => [...value].map((ch, i) => (i % 2 ? ch.toLowerCase() : ch.toUpperCase())).join("");

test("Upper, lower, mixed case and stray spaces all log in the same student", async () => {
    const variants = {
        upper: (v) => v.toUpperCase(),
        lower: (v) => v.toLowerCase(),
        mixed,
        spaced: (v) => `  ${v.toLowerCase().slice(0, 4)} ${v.toLowerCase().slice(4)}\t`
    };
    for (const [name, transform] of Object.entries(variants)) {
        // A fresh student per variant: one student may hold only one device lease.
        const row = registration();
        const before = JSON.stringify(registrationDb.db.tables.registrations);
        const result = await login(transform(row.registration_id), transform(row.hall_ticket_number));
        assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
        assert.ok(result.body.token, `${name}: token issued`);
        // The stored spelling is what the student, token and exam DB carry.
        assert.equal(result.body.student.registrationId, row.registration_id);
        assert.equal(result.body.student.hallTicketNumber, row.hall_ticket_number);
        assert.ok(db.db.tables.exam_candidates.some((c) => c.registration_id === row.registration_id), `${name}: candidate keyed by stored ID`);
        assert.equal(JSON.stringify(registrationDb.db.tables.registrations), before, `${name}: registrations unchanged`);
    }
});

test("Both values must belong to the same student, in any case", async () => {
    const a = registration();
    const b = registration();
    const result = await login(a.registration_id.toLowerCase(), b.hall_ticket_number.toLowerCase());
    assert.equal(result.status, 401);
    assert.equal(result.body.message, "Invalid Registration ID or Hall Ticket Number");
    assert.equal(result.body.token, undefined);
    assert.equal((await login(a.registration_id, "GTS/WRONG000XYZ00000")).status, 401);
});

test("Pattern characters cannot widen the match to other students", async () => {
    const row = registration();
    const attempts = [
        ["%", "%"], ["*", "*"], ["_", "_"],
        [row.registration_id.slice(0, 4) + "%", row.hall_ticket_number],
        [row.registration_id.slice(0, -1) + "_", row.hall_ticket_number.toLowerCase()],
        [row.registration_id, row.hall_ticket_number.slice(0, 4) + "%"],
        [row.registration_id, row.hall_ticket_number.slice(0, -1) + "*"],
        [row.registration_id + "\\", row.hall_ticket_number],
        [row.registration_id + ",hall_ticket_number.neq.x", row.hall_ticket_number]
    ];
    for (const [registrationId, hallTicketNumber] of attempts) {
        const result = await login(registrationId, hallTicketNumber);
        assert.equal(result.status, 401, `${registrationId} / ${hallTicketNumber}`);
        assert.equal(result.body.token, undefined);
    }
});

test("Existing rules still apply: required fields and payment eligibility", async () => {
    assert.equal((await login("", "x")).status, 400);
    assert.equal((await login("   ", "   ")).status, 400);
    const unpaid = registration({ paymentStatus: "PENDING" });
    const result = await login(unpaid.registration_id.toLowerCase(), unpaid.hall_ticket_number.toLowerCase());
    assert.equal(result.status, 403);
    assert.equal(result.body.token, undefined);
});

test("Records differing only by case are never guessed between", async () => {
    const upper = registration({ registrationId: "GTST26199999", hallTicketNumber: "GTS/DUPCASE999ABC99999" });
    registration({ registrationId: "gtst26199999", hallTicketNumber: "gts/dupcase999abc99999" });
    const result = await login(upper.registration_id, upper.hall_ticket_number);
    assert.equal(result.status, 500);
    assert.equal(result.body.token, undefined);
});
