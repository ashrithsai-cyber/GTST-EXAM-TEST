// Genuine multi-connection concurrency tests against a LOCAL PostgreSQL
// server. Each case holds a transaction open on one connection, proves the
// competing connection is really waiting on a row lock (pg_stat_activity),
// then commits and checks the loser's outcome.
//
// Run: TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres npm run test:postgres
// The URL must point at localhost. A temporary database is created, all
// real migrations 001-019 are applied to it, and it is dropped afterwards.
// Without TEST_DATABASE_URL every case is reported as skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { applyMigrations } = require("./helpers/realSchema");

const ADMIN_URL = process.env.TEST_DATABASE_URL;
let skip = false;
if (!ADMIN_URL) {
    skip = "TEST_DATABASE_URL is not set: real multi-connection PostgreSQL concurrency tests were NOT run";
} else if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(ADMIN_URL).hostname)) {
    skip = "TEST_DATABASE_URL must point at a local PostgreSQL server; refusing to run against a remote database";
}

let Client;
let dbName;
let dbUrl;
const clients = [];

async function connect() {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    clients.push(client);
    return client;
}

test.before(async () => {
    if (skip) return;
    ({ Client } = require("pg"));
    dbName = `gtst_concurrency_${crypto.randomBytes(6).toString("hex")}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    const setup = await connect();
    await applyMigrations((sql) => setup.query(sql));
});

test.after(async () => {
    if (skip) return;
    await Promise.allSettled(clients.map((client) => client.end()));
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
});

async function rpc(client, name, args) {
    const keys = Object.keys(args);
    const sql = `select ${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(",")}) as result`;
    return (await client.query(sql, Object.values(args))).rows[0].result;
}

// Resolves once `waiter`'s backend is blocked on a lock; fails otherwise.
async function waitUntilBlocked(observer, waiter) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await observer.query("select wait_event_type from pg_stat_activity where pid = $1", [waiter.processID]);
        if (rows[0]?.wait_event_type === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("the competing transaction never waited on a row lock");
}

// Holds `first` inside an open transaction, starts `second` on another
// connection, proves it is blocked, commits, and returns both results.
async function contend({ first, second }) {
    const [holder, waiter, observer] = [await connect(), await connect(), await connect()];
    await holder.query("begin");
    const firstResult = await first(holder);
    const pending = second(waiter);
    await waitUntilBlocked(observer, waiter);
    await holder.query("commit");
    return { firstResult, secondResult: await pending, observer };
}

async function fixture(client, { questions = 3, start = true } = {}) {
    const f = { exam: crypto.randomUUID(), cls: crypto.randomUUID(), subject: crypto.randomUUID(),
        candidate: crypto.randomUUID(), login: crypto.randomUUID(), questions: [] };
    await client.query("insert into exams(id,exam_code,exam_name,status,seconds_per_question) values($1,$2,'Fixture','INACTIVE',60)", [f.exam, `FX-${f.exam}`]);
    await client.query("insert into classes(id,exam_id,class_name,display_order) values($1,$2,'Class 10',1)", [f.cls, f.exam]);
    await client.query("insert into subjects(id,class_id,subject_key,subject_name,display_order) values($1,$2,'maths','Mathematics',1)", [f.subject, f.cls]);
    for (let index = 0; index < questions; index++) {
        const { rows } = await client.query("insert into questions(subject_id,question_number,question_text,option_a,option_b,option_c,option_d,correct_option,marks) values($1,$2,'Q','1','2','3','4','B',1) returning id",
            [f.subject, index + 1]);
        f.questions.push(rows[0].id);
    }
    await client.query("insert into exam_candidates(id,registration_id,full_name,student_class) values($1,$2,'Fixture','10')", [f.candidate, `REG-${f.candidate}`]);
    assert.equal((await rpc(client, "acquire_student_login_session", { p_candidate_id: f.candidate, p_login_session_id: f.login,
        p_token_expires_at: new Date(Date.now() + 3_600_000).toISOString() })).active, true);
    f.args = { p_candidate_id: f.candidate, p_login_session_id: f.login };
    f.start = { ...f.args, p_exam_id: f.exam, p_class_id: f.cls, p_seconds_per_question: 60 };
    if (start) f.session = (await rpc(client, "start_exam_attempt", f.start)).session.id;
    f.attempt = { p_session_id: f.session, ...f.args };
    if (start) {
        const { rows } = await client.query("select question_id from exam_attempt_questions where session_id=$1 order by position", [f.session]);
        f.order = rows.map((row) => row.question_id);
    }
    return f;
}
const answer = (client, f, questionId, option, advance = true) => rpc(client, "save_exam_answer",
    { ...f.attempt, p_question_id: questionId, p_selected_option: option, p_advance: advance });
const state = async (client, f) => (await client.query("select * from exam_sessions where id=$1", [f.session])).rows[0];
const answerCount = async (client, f) => Number((await client.query("select count(*) n from exam_answers where session_id=$1", [f.session])).rows[0].n);

test("1. Answer vs answer: one advance wins, the replay is stale, one answer row", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const { firstResult, secondResult } = await contend({
        first: (c) => answer(c, f, f.order[0], "B"),
        second: (c) => answer(c, f, f.order[0], "D")
    });
    assert.equal(firstResult.currentPosition, 1);
    assert.equal(secondResult.code, "STALE_QUESTION");
    assert.equal(await answerCount(setup, f), 1);
    assert.equal((await setup.query("select selected_option from exam_answers where session_id=$1", [f.session])).rows[0].selected_option, "B");
    assert.equal((await state(setup, f)).current_position, 1);
});

test("2a. Answer vs expiry: the worker skips a locked attempt, then finalizes it once with the answer kept", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    await setup.query("update exam_sessions set deadline_at=clock_timestamp()+interval '1 second' where id=$1", [f.session]);
    const holder = await connect();
    await holder.query("begin");
    assert.equal((await answer(holder, f, f.order[0], "B")).currentPosition, 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const worker = await connect();
    assert.equal(await rpc(worker, "expire_exam_attempts", { p_session_id: null }) >= 0, true);
    assert.equal((await state(setup, f)).status, "IN_PROGRESS", "SKIP LOCKED: the in-flight answer is not interrupted");
    await holder.query("commit");
    await rpc(worker, "expire_exam_attempts", { p_session_id: f.session });
    const final = await state(setup, f);
    assert.equal(final.status, "SUBMITTED");
    assert.equal(Number(final.total_score), 1, "the committed answer is scored");
    assert.equal(await rpc(worker, "expire_exam_attempts", { p_session_id: f.session }), 0, "finalized exactly once");
});

test("2b. Answer vs expiry: an answer waiting behind expiry sees the attempt already finalized", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    await setup.query("update exam_sessions set deadline_at=clock_timestamp()-interval '1 second' where id=$1", [f.session]);
    const { firstResult, secondResult } = await contend({
        first: (c) => rpc(c, "expire_exam_attempts", { p_session_id: f.session }),
        second: (c) => answer(c, f, f.order[0], "B")
    });
    assert.equal(firstResult, 1);
    assert.equal(secondResult.code, "NOT_IN_PROGRESS");
    assert.equal(await answerCount(setup, f), 0);
});

test("2c. Slow request: an answer that waits on a lock past the deadline is judged at execution time", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    await setup.query("update exam_sessions set deadline_at=clock_timestamp()+interval '700 milliseconds' where id=$1", [f.session]);
    const holder = await connect();
    const waiter = await connect();
    await holder.query("begin");
    await holder.query("select 1 from exam_sessions where id=$1 for update", [f.session]);
    const pending = answer(waiter, f, f.order[0], "B");
    await waitUntilBlocked(setup, waiter);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await holder.query("commit");
    const late = await pending;
    assert.deepEqual([late.timedOut, late.autoSubmitted, late.status], [true, true, "SUBMITTED"]);
    assert.equal(await answerCount(setup, f), 0, "the late selection is not stored");
});

test("3a. Submit vs proctoring block: a block waiting behind submit leaves the attempt SUBMITTED", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const { firstResult, secondResult } = await contend({
        first: (c) => rpc(c, "submit_exam_attempt", f.attempt),
        second: (c) => rpc(c, "block_exam_attempt", { ...f.attempt, p_max_warnings: 3 })
    });
    assert.equal(firstResult.status, "SUBMITTED");
    assert.deepEqual([secondResult.status, secondResult.blocked], ["SUBMITTED", false]);
    assert.equal((await state(setup, f)).status, "SUBMITTED");
});

test("3b. Submit vs proctoring block: a submit waiting behind the block cannot complete a blocked attempt", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const { firstResult, secondResult } = await contend({
        first: (c) => rpc(c, "block_exam_attempt", { ...f.attempt, p_max_warnings: 3 }),
        second: (c) => rpc(c, "submit_exam_attempt", f.attempt)
    });
    assert.equal(firstResult.blocked, true);
    assert.deepEqual([secondResult.code, secondResult.status], ["NOT_IN_PROGRESS", "BLOCKED"]);
    const final = await state(setup, f);
    assert.equal(final.status, "BLOCKED");
    assert.equal(final.submitted_at, null);
});

test("3c. Submit vs proctoring block under free-running parallel load never reverses a submission", { skip }, async () => {
    const setup = await connect();
    const [a, b] = [await connect(), await connect()];
    for (let round = 0; round < 25; round++) {
        const f = await fixture(setup);
        const [submitted, blocked] = await Promise.all([
            rpc(a, "submit_exam_attempt", f.attempt),
            rpc(b, "block_exam_attempt", { ...f.attempt, p_max_warnings: 3 })
        ]);
        const final = await state(setup, f);
        if (submitted.status === "SUBMITTED") {
            assert.equal(final.status, "SUBMITTED");
            assert.equal(blocked.blocked, false);
        } else {
            assert.equal(final.status, "BLOCKED");
            assert.equal(final.submitted_at, null);
        }
    }
});

test("4. Login vs login: two devices racing for one student yield exactly one active lease", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup, { start: false });
    await setup.query("delete from student_login_sessions where candidate_id=$1", [f.candidate]);
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const [deviceA, deviceB] = [crypto.randomUUID(), crypto.randomUUID()];
    const { firstResult, secondResult } = await contend({
        first: (c) => rpc(c, "acquire_student_login_session", { p_candidate_id: f.candidate, p_login_session_id: deviceA, p_token_expires_at: expires }),
        second: (c) => rpc(c, "acquire_student_login_session", { p_candidate_id: f.candidate, p_login_session_id: deviceB, p_token_expires_at: expires })
    });
    assert.equal(firstResult.active, true);
    assert.equal(secondResult.active, false);
    const { rows } = await setup.query("select login_session_id from student_login_sessions where candidate_id=$1", [f.candidate]);
    assert.deepEqual(rows.map((row) => row.login_session_id), [deviceA]);
});

test("5. Two-device access: device B's login waits for device A's answer and is then rejected; B cannot write", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const deviceB = crypto.randomUUID();
    const { firstResult, secondResult } = await contend({
        first: (c) => answer(c, f, f.order[0], "B"),
        second: (c) => rpc(c, "acquire_student_login_session", { p_candidate_id: f.candidate, p_login_session_id: deviceB,
            p_token_expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    });
    assert.equal(firstResult.currentPosition, 1);
    assert.equal(secondResult.active, false);
    const asB = { p_session_id: f.session, p_candidate_id: f.candidate, p_login_session_id: deviceB };
    assert.equal((await rpc(setup, "save_exam_answer", { ...asB, p_question_id: f.order[1], p_selected_option: "A", p_advance: true })).code, "ACTIVE_SESSION_REQUIRED");
    assert.equal((await rpc(setup, "submit_exam_attempt", asB)).code, "ACTIVE_SESSION_REQUIRED");
    assert.equal((await rpc(setup, "block_exam_attempt", { ...asB, p_max_warnings: 3 })).code, "ACTIVE_SESSION_REQUIRED");
    assert.equal((await state(setup, f)).status, "IN_PROGRESS");
});

test("6. Submit vs submit: finalized once with one completion time", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const { firstResult, secondResult } = await contend({
        first: (c) => rpc(c, "submit_exam_attempt", f.attempt),
        second: (c) => rpc(c, "submit_exam_attempt", f.attempt)
    });
    assert.equal(firstResult.status, "SUBMITTED");
    assert.equal(secondResult.status, "SUBMITTED");
    assert.equal(new Date(secondResult.submittedAt).toISOString(), new Date(firstResult.submittedAt).toISOString());
});

test("7a. Answer vs submit: a submit waiting behind an answer includes that answer", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const { firstResult, secondResult } = await contend({
        first: (c) => answer(c, f, f.order[0], "B"),
        second: (c) => rpc(c, "submit_exam_attempt", f.attempt)
    });
    assert.equal(firstResult.currentPosition, 1);
    assert.equal(secondResult.status, "SUBMITTED");
    assert.equal(secondResult.attemptedCount, 1);
    assert.equal(Number((await state(setup, f)).total_score), 1);
});

test("7b. Answer vs submit: an answer waiting behind a submit is rejected and not stored", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup);
    const { secondResult } = await contend({
        first: (c) => rpc(c, "submit_exam_attempt", f.attempt),
        second: (c) => answer(c, f, f.order[0], "B")
    });
    assert.deepEqual([secondResult.code, secondResult.status], ["NOT_IN_PROGRESS", "SUBMITTED"]);
    assert.equal(await answerCount(setup, f), 0);
});

test("8. Start vs start: concurrent attempt creation yields one initialized attempt", { skip }, async () => {
    const setup = await connect();
    const f = await fixture(setup, { start: false });
    const { firstResult, secondResult } = await contend({
        first: (c) => rpc(c, "start_exam_attempt", f.start),
        second: (c) => rpc(c, "start_exam_attempt", f.start)
    });
    assert.equal(firstResult.created, true);
    assert.equal(secondResult.created, false);
    assert.equal(secondResult.session.id, firstResult.session.id);
    assert.ok(secondResult.session.sequence_initialized_at);
    const { rows } = await setup.query("select count(*) n from exam_sessions where candidate_id=$1", [f.candidate]);
    assert.equal(Number(rows[0].n), 1);
});
