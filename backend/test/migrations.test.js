const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

let db;
const migration = (name) => fs.readFileSync(path.join(__dirname, "..", "sql", name), "utf8");
// The core schema represents the existing 001-016 deployment. The test DB
// is in-memory; no environment credentials or external database are used.
const coreSchema = `
create role anon; create role authenticated; create role service_role;
create table exam_candidates(id uuid primary key, registration_id text unique);
create table exams(id uuid primary key,exam_code text,exam_name text,status text,
 seconds_per_question integer,exam_start_at timestamptz,duration_minutes integer);
create table classes(id uuid primary key,exam_id uuid references exams(id),class_name text,display_order integer);
create table subjects(id uuid primary key,class_id uuid references classes(id),subject_key text,subject_name text,display_order integer);
create table questions(id uuid primary key,subject_id uuid references subjects(id),question_number integer,
 question_text text,passage text,option_a text,option_b text,option_c text,option_d text,
 correct_option char(1),marks integer,status text default 'ACTIVE');
create table exam_sessions(id uuid primary key,candidate_id uuid references exam_candidates(id),
 exam_id uuid references exams(id),class_id uuid references classes(id),status text default 'IN_PROGRESS',
 current_subject_index integer default 0,current_question_index integer default 0,seconds_per_question integer,
 question_started_at timestamptz default clock_timestamp(),started_at timestamptz default clock_timestamp(),
 submitted_at timestamptz,last_activity_at timestamptz default clock_timestamp(),total_score numeric,max_score numeric);
create table exam_answers(id uuid default gen_random_uuid(),session_id uuid references exam_sessions(id),
 question_id uuid references questions(id),subject_id uuid references subjects(id),selected_option char(1),
 is_attempted boolean,is_correct boolean,time_spent_seconds integer,answered_at timestamptz,
 unique(session_id,question_id));
create table student_presence(candidate_id uuid primary key references exam_candidates(id),stage text,updated_at timestamptz);
`;

test.before(async () => {
    db = new PGlite();
    await db.exec(coreSchema);
    await db.exec(migration("017_sequential_attempts.sql"));
    await db.exec(migration("018_single_device_sessions.sql"));
    await db.exec(migration("019_attempt_integrity.sql"));
    // Controlled reapplication is exercised only in this disposable test
    // schema; it is not a recommendation to replay migrations on populated DBs.
    await db.exec(migration("017_sequential_attempts.sql"));
    await db.exec(migration("018_single_device_sessions.sql"));
    await db.exec(migration("019_attempt_integrity.sql"));
});
test.after(async () => { await db?.close(); });

async function rpc(name, args) {
    const params = Object.values(args);
    const placeholders = Object.keys(args).map((key, index) => key + " => $" + (index + 1)).join(",");
    const { rows } = await db.query("select " + name + "(" + placeholders + ") as result", params);
    return rows[0].result;
}

async function fixture({ randomized = false, emptyFirstSubject = false } = {}) {
    const candidate = crypto.randomUUID();
    const login = crypto.randomUUID();
    const exam = crypto.randomUUID();
    const cls = crypto.randomUUID();
    const subject = crypto.randomUUID();
    const session = crypto.randomUUID();
    const questions = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.query("insert into exam_candidates values($1,$2)", [candidate, candidate]);
    await db.query("insert into exams(id,exam_code,exam_name,status,seconds_per_question,randomize_questions) values($1,$2,'Exam','ACTIVE',60,$3)", [exam, exam, randomized]);
    await db.query("insert into classes values($1,$2,'Class 10',1)", [cls, exam]);
    if (emptyFirstSubject) await db.query("insert into subjects values($1,$2,'empty','Empty',1)", [crypto.randomUUID(), cls]);
    await db.query("insert into subjects values($1,$2,'maths','Mathematics',$3)", [subject, cls, emptyFirstSubject ? 2 : 1]);
    for (let index = 0; index < questions.length; index++) {
        await db.query("insert into questions(id,subject_id,question_number,question_text,option_a,option_b,option_c,option_d,correct_option,marks) values($1,$2,$3,$4,'One','Two','Three','Four','B',2)",
            [questions[index], subject, index * 2 + 1, "Question " + (index + 1)]);
    }
    await db.query("insert into exam_sessions(id,candidate_id,exam_id,class_id,seconds_per_question) values($1,$2,$3,$4,60)", [session, candidate, exam, cls]);
    await rpc("acquire_student_login_session", { p_candidate_id: candidate, p_login_session_id: login,
        p_token_expires_at: new Date(Date.now() + 3600000).toISOString() });
    const args = { p_session_id: session, p_candidate_id: candidate, p_login_session_id: login };
    const state = await rpc("init_exam_attempt", args);
    assert.equal(state.total_questions, 3);
    return { ...args, candidate, login, exam, cls, subject, session, questions, state };
}

async function answer(f, question, selectedOption, advance = true) {
    return rpc("save_exam_answer", { p_session_id: f.session, p_candidate_id: f.candidate,
        p_login_session_id: f.login, p_question_id: question, p_selected_option: selectedOption, p_advance: advance });
}
async function state(f) {
    return (await db.query("select * from exam_sessions where id=$1", [f.session])).rows[0];
}
async function sequence(f) {
    return (await db.query("select * from exam_attempt_questions where session_id=$1 order by position", [f.session])).rows;
}

test("Real SQL persists random sequence without duplicates and ignores later bank edits", async () => {
    const f = await fixture({ randomized: true });
    const before = await sequence(f);
    assert.equal(new Set(before.map((q) => q.question_id)).size, 3);
    assert.deepEqual(before.map((q) => q.position), [0, 1, 2]);
    await db.query("update questions set question_number=question_number+50,question_text='Changed',correct_option='D' where subject_id=$1", [f.subject]);
    await rpc("init_exam_attempt", { p_session_id: f.session, p_candidate_id: f.candidate, p_login_session_id: f.login });
    assert.deepEqual(await sequence(f), before);
    assert.equal((await answer(f, before[0].question_id, "B")).currentPosition, 1);
    const end = await rpc("submit_exam_attempt", { p_session_id: f.session, p_candidate_id: f.candidate, p_login_session_id: f.login });
    assert.equal(end.status, "SUBMITTED");
    assert.equal((await state(f)).total_score, "2", "scored against the delivered snapshot");
});

test("Real SQL atomically advances once, rejects replay and saves server-measured elapsed time", async () => {
    const f = await fixture();
    const results = await Promise.all([answer(f, f.questions[0], "B"), answer(f, f.questions[0], "D")]);
    assert.equal(results.filter((result) => result.currentPosition === 1).length, 1);
    assert.equal(results.filter((result) => result.code === "STALE_QUESTION").length, 1);
    const rows = (await db.query("select * from exam_answers where session_id=$1", [f.session])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].selected_option, "B");
    assert.equal((await state(f)).current_position, 1);
    assert.ok(rows[0].time_spent_seconds >= 0 && rows[0].time_spent_seconds <= 60);
});

test("Real SQL preserves a timely draft on timeout and rejects a new late selection", async () => {
    const f = await fixture();
    assert.equal((await answer(f, f.questions[0], "B", false)).selectedOption, "B");
    assert.equal((await state(f)).current_position, 0);
    await db.query("update exam_sessions set question_started_at=clock_timestamp()-interval '61 seconds' where id=$1", [f.session]);
    assert.equal((await answer(f, f.questions[0], "D", false)).code, "QUESTION_EXPIRED");
    const result = await answer(f, f.questions[0], "D");
    assert.equal(result.timedOut, true);
    assert.equal((await db.query("select selected_option from exam_answers where session_id=$1", [f.session])).rows[0].selected_option, "B");
    assert.equal((await answer(f, f.questions[2], "B")).code, "STALE_QUESTION");
});

test("Real SQL enforces device lease again inside answer and submit transactions", async () => {
    const f = await fixture();
    const other = crypto.randomUUID();
    let result = await rpc("save_exam_answer", { p_session_id: f.session, p_candidate_id: f.candidate,
        p_login_session_id: other, p_question_id: f.questions[0], p_selected_option: "B", p_advance: true });
    assert.equal(result.code, "ACTIVE_SESSION_REQUIRED");
    await db.query("update student_login_sessions set expires_at=clock_timestamp()-interval '1 second' where candidate_id=$1", [f.candidate]);
    result = await answer(f, f.questions[0], "B");
    assert.equal(result.code, "ACTIVE_SESSION_REQUIRED");
    assert.equal((await state(f)).current_position, 0);
    result = await rpc("submit_exam_attempt", { p_session_id: f.session, p_candidate_id: f.candidate, p_login_session_id: f.login });
    assert.equal(result.code, "ACTIVE_SESSION_REQUIRED");
});

test("Real SQL final answer and duplicate submit finalize exactly once without exposing scores", async () => {
    const f = await fixture();
    await answer(f, f.questions[0], "B");
    await answer(f, f.questions[1], "B");
    const final = await answer(f, f.questions[2], "B");
    assert.equal(final.status, "SUBMITTED");
    assert.equal(final.examComplete, true);
    assert.equal(final.autoSubmitted, true);
    const submitted = await state(f);
    const again = await rpc("submit_exam_attempt", { p_session_id: f.session, p_candidate_id: f.candidate, p_login_session_id: f.login });
    assert.equal(new Date(again.submittedAt).toISOString(), submitted.submitted_at.toISOString());
    assert.equal(again.totalScore, undefined);
    assert.equal((await answer(f, f.questions[2], "D")).code, "NOT_IN_PROGRESS");
    assert.equal((await state(f)).total_score, "6");
});

test("Real SQL deadline cleanup submits disconnected students and protects saved answers", async () => {
    const f = await fixture();
    await answer(f, f.questions[0], "B", false);
    await db.query("update exam_sessions set deadline_at=clock_timestamp()-interval '1 second' where id=$1", [f.session]);
    assert.equal(await rpc("expire_exam_attempts", { p_session_id: f.session }), 1);
    assert.equal(await rpc("expire_exam_attempts", { p_session_id: f.session }), 0);
    assert.equal((await state(f)).status, "SUBMITTED");
    assert.equal((await state(f)).total_score, "2");
    assert.equal((await db.query("select stage from student_presence where candidate_id=$1", [f.candidate])).rows[0].stage, "COMPLETED");
});

test("Real SQL skips empty sections without prematurely completing the examination", async () => {
    const f = await fixture({ emptyFirstSubject: true });
    assert.equal(f.state.current_position, 0);
    assert.equal(f.state.current_subject_index, 1);
    assert.equal((await answer(f, f.questions[0], "B")).examComplete, false);
});

test("Real SQL RLS and execute grants deny the browser role question snapshots and transaction functions", async () => {
    await db.exec("set role anon");
    await assert.rejects(db.query("select * from exam_attempt_questions"), /permission denied/);
    await assert.rejects(db.query("select finalize_exam_attempt($1)", [crypto.randomUUID()]), /permission denied/);
    await assert.rejects(db.query("select expire_exam_attempts(null)"), /permission denied/);
    await db.exec("reset role");
});
