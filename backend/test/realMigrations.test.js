// Applies the REAL migrations 001-023 in order to a clean in-memory
// PostgreSQL (PGlite) and verifies relationships, constraints, status
// rules and the attempt functions against that real schema. PGlite has a
// single connection, so genuine lock contention is covered separately by
// postgres.concurrency.test.js against a local multi-connection server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { applyMigrations, migrationFiles } = require("./helpers/realSchema");

let db;
let applied;
const AUDIT_SQL = fs.readFileSync(path.join(__dirname, "..", "sql", "checks", "attempt_consistency_audit.sql"), "utf8");

test.before(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    applied = await applyMigrations((sql) => db.exec(sql));
});
test.after(async () => { await db?.close(); });

test('Real SQL records violations atomically, deduplicates retries, and protects finalized attempts', async () => {
    const f = await fixture();
    const args = { ...f.args, p_session_id: f.session, p_client_event_id: crypto.randomUUID(),
        p_event_type: 'CAMERA_DISABLED', p_event_message: 'Unplugged',
        p_occurred_at: new Date().toISOString(), p_is_violation: true };
    assert.equal((await rpc('record_exam_event', args)).violationCount, 1);
    assert.equal((await rpc('record_exam_event', args)).duplicate, true);
    assert.equal((await one('select count(*)::integer as n from exam_events where session_id=$1', [f.session])).n, 1);
    await rpc('submit_exam_attempt', { ...f.args, p_session_id: f.session });
    const delayed = await rpc('record_exam_event', { ...args, p_client_event_id: crypto.randomUUID() });
    assert.equal(delayed.violationCount, 2);
    const late = await rpc('record_exam_event', { ...args, p_client_event_id: crypto.randomUUID(), p_occurred_at: null });
    assert.equal(late.code, 'NOT_IN_PROGRESS');
    assert.equal((await one('select status from exam_sessions where id=$1', [f.session])).status, 'SUBMITTED');
    assert.equal((await one("select has_function_privilege('anon','record_exam_event(uuid,uuid,uuid,uuid,text,text,timestamptz,boolean)','EXECUTE') as allowed")).allowed, false);
});

test("Admin reset removes one inactive exam's attempts and releases affected students", async () => {
    const f = await fixture();
    await db.query("update classes set class_name='Reset 99' where id=$1", [f.cls]);
    await db.query("update exam_candidates set student_class='99' where id=$1", [f.candidate]);
    assert.equal((await rpc("admin_reset_exam_attempts", { p_exam_id: f.exam })).code, "EXAM_HAS_ACTIVE_ATTEMPTS");

    await answer(f, f.questions[0], "B", false);
    await rpc("record_exam_event", {
        ...attempt(f), p_client_event_id: crypto.randomUUID(), p_event_type: "TAB_SWITCH",
        p_event_message: "fixture violation", p_occurred_at: new Date().toISOString(), p_is_violation: true
    });
    await db.query(`insert into exam_preflight(candidate_id,exam_id,camera_check,system_check_completed_at)
        values($1,$2,true,now())`, [f.candidate, f.exam]);
    await db.query("insert into student_presence(candidate_id,stage) values($1,'IN_EXAM')", [f.candidate]);
    await db.query(`insert into system_check_screenshots(candidate_id,exam_id,session_id,registration_id,storage_path)
        values($1,$2,$3,$4,'fixture/photo.jpg')`, [f.candidate, f.exam, f.session, `REG-${f.candidate}`]);

    await rpc("submit_exam_attempt", attempt(f));
    const otherExam = crypto.randomUUID();
    const otherClass = crypto.randomUUID();
    const otherSubject = crypto.randomUUID();
    await db.query("insert into exams(id,exam_code,exam_name,status,seconds_per_question) values($1,$2,'Other fixture','INACTIVE',60)", [otherExam, `OTHER-${otherExam}`]);
    await db.query("insert into classes(id,exam_id,class_name,display_order) values($1,$2,'Other Reset 99',1)", [otherClass, otherExam]);
    await db.query("insert into subjects(id,class_id,subject_key,subject_name,display_order) values($1,$2,'maths','Mathematics',1)", [otherSubject, otherClass]);
    await db.query("insert into questions(subject_id,question_number,question_text,option_a,option_b,option_c,option_d,correct_option,marks) values($1,1,'Q','1','2','3','4','B',1)", [otherSubject]);
    const otherStarted = await rpc("start_exam_attempt", {
        ...f.args, p_exam_id: otherExam, p_class_id: otherClass, p_seconds_per_question: 60
    });
    assert.equal(otherStarted.created, true);
    assert.equal((await rpc("admin_reset_exam_attempts", { p_exam_id: f.exam })).code, "CANDIDATE_ACTIVE_IN_ANOTHER_EXAM");
    await rpc("submit_exam_attempt", { ...f.args, p_session_id: otherStarted.session.id });

    const activeExam = await one("select id from exams where status='ACTIVE'");
    if (activeExam) await db.query("update exams set status='INACTIVE' where id=$1", [activeExam.id]);
    try {
        await db.query("update exams set status='ACTIVE' where id=$1", [f.exam]);
        assert.equal((await rpc("admin_reset_exam_attempts", { p_exam_id: f.exam })).code, "EXAM_ACTIVE");
    } finally {
        await db.query("update exams set status='INACTIVE' where id=$1", [f.exam]);
        if (activeExam) await db.query("update exams set status='ACTIVE' where id=$1", [activeExam.id]);
    }

    const result = await rpc("admin_reset_exam_attempts", { p_exam_id: f.exam });
    assert.equal(result.success, true);
    assert.equal(result.deletedAttempts, 1);
    assert.equal(result.deletedAnswers, 1);
    assert.equal(result.deletedEvents, 1);
    assert.equal(result.releasedLoginSessions, 1);
    assert.equal(result.clearedPreflightRecords, 1);
    assert.equal(result.clearedPresenceRecords, 1);
    assert.equal((await one("select count(*)::int n from exam_sessions where exam_id=$1", [f.exam])).n, 0);
    assert.equal((await one("select count(*)::int n from exam_answers where session_id=$1", [f.session])).n, 0);
    assert.equal((await one("select count(*)::int n from exam_events where session_id=$1", [f.session])).n, 0);
    assert.equal((await one("select count(*)::int n from student_login_sessions where candidate_id=$1", [f.candidate])).n, 0);
    assert.equal((await one("select count(*)::int n from exam_candidates where id=$1", [f.candidate])).n, 1);
    assert.equal((await one("select count(*)::int n from questions where id=$1", [f.questions[0]])).n, 1);
    assert.equal((await one("select session_id from system_check_screenshots where candidate_id=$1 and exam_id=$2", [f.candidate, f.exam])).session_id, null);
});

test("Admin permanent delete removes exam data and returns private photo paths", async () => {
    const f = await fixture();
    await db.query(`insert into system_check_screenshots(candidate_id,exam_id,session_id,registration_id,storage_path)
        values($1,$2,$3,$4,'fixture/permanent-delete.jpg')`,
    [f.candidate, f.exam, f.session, `REG-${f.candidate}`]);

    assert.equal((await rpc("admin_delete_exam_completely", { p_exam_id: f.exam })).code, "EXAM_HAS_ACTIVE_ATTEMPTS");
    await answer(f, f.questions[0], "B", false);
    await rpc("record_exam_event", {
        ...attempt(f), p_client_event_id: crypto.randomUUID(), p_event_type: "TAB_SWITCH",
        p_event_message: "fixture violation", p_occurred_at: new Date().toISOString(), p_is_violation: true
    });
    await rpc("submit_exam_attempt", attempt(f));

    const activeExam = await one("select id from exams where status='ACTIVE'");
    if (activeExam) await db.query("update exams set status='INACTIVE' where id=$1", [activeExam.id]);
    try {
        await db.query("update exams set status='ACTIVE' where id=$1", [f.exam]);
        assert.equal((await rpc("admin_delete_exam_completely", { p_exam_id: f.exam })).code, "EXAM_ACTIVE");
    } finally {
        await db.query("update exams set status='INACTIVE' where id=$1", [f.exam]);
        if (activeExam) await db.query("update exams set status='ACTIVE' where id=$1", [activeExam.id]);
    }

    const result = await rpc("admin_delete_exam_completely", { p_exam_id: f.exam });
    assert.equal(result.success, true);
    assert.equal(result.deletedAttempts, 1);
    assert.equal(result.deletedAnswers, 1);
    assert.equal(result.deletedEvents, 1);
    assert.equal(result.deletedCheckInPhotos, 1);
    assert.deepEqual(result.screenshotPaths, ["fixture/permanent-delete.jpg"]);
    assert.equal((await one("select count(*)::int n from exams where id=$1", [f.exam])).n, 0);
    assert.equal((await one("select count(*)::int n from classes where id=$1", [f.cls])).n, 0);
    assert.equal((await one("select count(*)::int n from questions where id=$1", [f.questions[0]])).n, 0);
    assert.equal((await one("select count(*)::int n from exam_sessions where id=$1", [f.session])).n, 0);
    assert.equal((await one("select count(*)::int n from system_check_screenshots where exam_id=$1", [f.exam])).n, 0);
    assert.equal((await one("select count(*)::int n from exam_candidates where id=$1", [f.candidate])).n, 1);
});

test("Monitoring event summary returns counts without raw event history", async () => {
    const f = await fixture();
    await db.query(`insert into exam_events(session_id,event_type,event_message,is_violation)
        values ($1,'CAMERA_DISABLED','camera',true),($1,'TAB_SWITCH','tab',null),
               ($1,'NETWORK_DISCONNECT','network',null)`, [f.session]);

    const summary = await one("select * from admin_monitoring_event_summary(array[$1::uuid])", [f.session]);
    assert.deepEqual(summary.event_counts, {
        CAMERA_DISABLED: 1, TAB_SWITCH: 1, NETWORK_DISCONNECT: 1
    });
    assert.equal(summary.violation_count, 2);
    assert.ok(summary.latest_event_at);
    assert.equal((await one("select has_function_privilege('anon','admin_monitoring_event_summary(uuid[])','EXECUTE') as allowed")).allowed, false);
});

test("Admin monitoring progress follows the attempt snapshot, not later question-bank edits", async () => {
    const f = await fixture({ questions: 3 });
    const started = await one("select * from admin_exam_attempt_progress(array[$1::uuid])", [f.session]);
    assert.deepEqual(started, {
        session_id: f.session, attempted: 0, total: 3, current_subject: "Mathematics"
    });

    await answer(f, f.questions[0], "B");
    await db.query("update subjects set subject_name='Renamed in bank' where id=$1", [f.subject]);
    await db.query(`insert into questions(subject_id,question_number,question_text,option_a,option_b,option_c,option_d,correct_option,marks)
        values($1,99,'Added after attempt start','1','2','3','4','B',1)`, [f.subject]);

    const progressed = await one("select * from admin_exam_attempt_progress(array[$1::uuid])", [f.session]);
    assert.deepEqual(progressed, {
        session_id: f.session, attempted: 1, total: 3, current_subject: "Mathematics"
    });
});

test("Migration 020 upgrades representative legacy exam data without rewriting it", async () => {
    const currentDb = db;
    db = new PGlite({ extensions: { pgcrypto } });
    try {
        await applyMigrations((sql) => db.exec(sql), { through: "019_attempt_integrity.sql" });
        const f = await fixture();
        const setting = await one("select id from exam_settings order by created_at limit 1");
        await db.query("update exam_settings set camera_required=false, proctoring_enabled=false where id=$1", [setting.id]);
        await db.query(`insert into exam_preflight(candidate_id,exam_id,camera_check,microphone_check,fullscreen_check)
            values($1,$2,true,true,true)`, [f.candidate, f.exam]);
        const legacyEvent = await one(`insert into exam_events(session_id,event_type,event_message,warning_number)
            values($1,'TAB_SWITCH','legacy event',1) returning id,session_id,event_type,event_message,warning_number,created_at`,
        [f.session]);

        const migrations = await applyMigrations((sql) => db.exec(sql), { from: "020_reliable_proctoring.sql" });
        assert.deepEqual(migrations, ["020_reliable_proctoring.sql", "021_admin_monitoring_summary.sql", "022_admin_reset_exam_attempts.sql", "023_admin_delete_exam_completely.sql"]);
        const preservedEvent = await one(`select id,session_id,event_type,event_message,warning_number,created_at
            from exam_events where id=$1`, [legacyEvent.id]);
        assert.deepEqual(preservedEvent, legacyEvent);
        assert.deepEqual(await one("select camera_required,proctoring_enabled from exam_settings where id=$1", [setting.id]),
            { camera_required: false, proctoring_enabled: false });
        assert.deepEqual(await one("select camera_check,microphone_check,fullscreen_check from exam_preflight where candidate_id=$1 and exam_id=$2", [f.candidate, f.exam]),
            { camera_check: true, microphone_check: true, fullscreen_check: true });
        assert.equal((await one(`select count(*)::int n from information_schema.columns
            where table_schema='public' and table_name in ('exam_settings','exam_preflight')
              and column_name like 'screen_sharing_%'`)).n, 0);
        assert.equal((await one("select client_event_id,occurred_at,is_violation from exam_events where id=$1", [legacyEvent.id])).is_violation, null);

        const recorded = await rpc("record_exam_event", {
            ...f.args, p_session_id: f.session, p_client_event_id: crypto.randomUUID(),
            p_event_type: "CAMERA_DISABLED", p_event_message: "new event",
            p_occurred_at: new Date().toISOString(), p_is_violation: true
        });
        assert.equal(recorded.success, true);
        const removedEvent = await rpc("record_exam_event", {
            ...f.args, p_session_id: f.session, p_client_event_id: crypto.randomUUID(),
            p_event_type: "SCREEN_SHARE_STOPPED", p_event_message: "legacy event",
            p_occurred_at: new Date().toISOString(), p_is_violation: true
        });
        assert.equal(removedEvent.code, "INVALID_EVENT");
        assert.equal((await one("select count(*)::int n from exam_events where session_id=$1", [f.session])).n, 2);
    } finally {
        await db.close();
        db = currentDb;
    }
});

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
async function rpc(name, args) {
    const keys = Object.keys(args);
    const call = `select ${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(",")}) as result`;
    return (await db.query(call, Object.values(args))).rows[0].result;
}
async function rejectsWith(promise, code) {
    await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
}

async function fixture({ questions = 3, start = true } = {}) {
    const f = { exam: crypto.randomUUID(), cls: crypto.randomUUID(), subject: crypto.randomUUID(),
        candidate: crypto.randomUUID(), login: crypto.randomUUID(), questions: [] };
    await db.query("insert into exams(id,exam_code,exam_name,status,seconds_per_question) values($1,$2,'Fixture','INACTIVE',60)", [f.exam, `FX-${f.exam}`]);
    await db.query("insert into classes(id,exam_id,class_name,display_order) values($1,$2,'Class 10',1)", [f.cls, f.exam]);
    await db.query("insert into subjects(id,class_id,subject_key,subject_name,display_order) values($1,$2,'maths','Mathematics',1)", [f.subject, f.cls]);
    for (let index = 0; index < questions; index++) {
        const id = crypto.randomUUID();
        f.questions.push(id);
        await db.query("insert into questions(id,subject_id,question_number,question_text,option_a,option_b,option_c,option_d,correct_option,marks) values($1,$2,$3,'Q','1','2','3','4','B',1)",
            [id, f.subject, index + 1]);
    }
    await db.query("insert into exam_candidates(id,registration_id,full_name,student_class) values($1,$2,'Fixture','10')", [f.candidate, `REG-${f.candidate}`]);
    const lease = await rpc("acquire_student_login_session", { p_candidate_id: f.candidate, p_login_session_id: f.login,
        p_token_expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(lease.active, true);
    f.args = { p_candidate_id: f.candidate, p_login_session_id: f.login };
    if (start) {
        const started = await rpc("start_exam_attempt", { ...f.args, p_exam_id: f.exam, p_class_id: f.cls, p_seconds_per_question: 60 });
        assert.equal(started.created, true, JSON.stringify(started));
        f.session = started.session.id;
    }
    return f;
}
const attempt = (f) => ({ p_session_id: f.session, ...f.args });
const answer = (f, questionId, option, advance = true) => rpc("save_exam_answer",
    { ...attempt(f), p_question_id: questionId, p_selected_option: option, p_advance: advance });
const sequence = async (f) => (await db.query("select question_id from exam_attempt_questions where session_id=$1 order by position", [f.session])).rows.map((row) => row.question_id);
const sessionState = (f) => one("select * from exam_sessions where id=$1", [f.session]);

test("All real migrations 001-023 apply in order to a clean database and controlled reapplication preserves the fixture", async () => {
    assert.deepEqual(applied, migrationFiles());
    assert.ok(applied.includes("020_reliable_proctoring.sql"));
    // This reapplication is limited to the disposable clean PGlite fixture.
    // It does not establish data-safe replay of historical migrations on a
    // populated database (in particular, migration 010 performs data cleanup).
    await applyMigrations((sql) => db.exec(sql), { from: "002" });
    // 001's seed survives 010 by being given a class (fresh-install path).
    const seed = await one(`select count(distinct c.id)::int classes, count(q.id)::int questions
        from exams e join classes c on c.exam_id=e.id join subjects s on s.class_id=c.id join questions q on q.subject_id=s.id
        where e.exam_code='GTST-2026'`);
    assert.deepEqual(seed, { classes: 1, questions: 60 });
});

test("Foreign keys connect student, exam, class, attempt, sequence, answer, presence and device session", async () => {
    const { rows } = await db.query(`
        select c.conrelid::regclass::text tbl, c.confrelid::regclass::text ref,
               array_to_string(array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k order by a.attnum), ',') cols,
               c.convalidated validated
        from pg_constraint c where c.contype='f'`);
    const has = (tbl, cols, ref) => {
        const found = rows.find((row) => row.tbl === tbl && row.cols === cols && row.ref === ref);
        assert.ok(found, `missing FK ${tbl}(${cols}) -> ${ref}`);
        return found;
    };
    has("exam_sessions", "candidate_id", "exam_candidates");
    has("exam_sessions", "exam_id", "exams");
    has("exam_sessions", "class_id", "classes");
    has("classes", "exam_id", "exams");
    has("subjects", "class_id", "classes");
    has("questions", "subject_id", "subjects");
    has("exam_attempt_questions", "session_id", "exam_sessions");
    has("exam_attempt_questions", "question_id", "questions");
    has("exam_attempt_questions", "subject_id", "subjects");
    has("exam_answers", "session_id", "exam_sessions");
    has("exam_answers", "question_id", "questions");
    assert.equal(has("exam_answers", "session_id,question_id", "exam_attempt_questions").validated, true,
        "composite answer -> sequence FK is validated on a clean database");
    has("student_presence", "candidate_id", "exam_candidates");
    has("student_login_sessions", "candidate_id", "exam_candidates");
    const indexes = (await db.query("select indexname from pg_indexes where tablename='exam_sessions'")).rows.map((row) => row.indexname);
    assert.ok(indexes.includes("exam_sessions_one_in_progress_per_candidate"));
});

test("Constraints reject duplicate attempts, foreign answers and invalid status changes", async () => {
    const f = await fixture();
    // Duplicate attempt for the same exam.
    await rejectsWith(db.query("insert into exam_sessions(candidate_id,exam_id,class_id,status) values($1,$2,$3,'BLOCKED')", [f.candidate, f.exam, f.cls]), "23505");
    // A second running attempt in another exam.
    const other = await fixture({ start: false });
    await rejectsWith(db.query("insert into exam_sessions(candidate_id,exam_id,class_id,status) values($1,$2,$3,'IN_PROGRESS')", [f.candidate, other.exam, other.cls]), "23505");
    // An answer for a question that is not in this attempt's sequence.
    await rejectsWith(db.query("insert into exam_answers(session_id,question_id,subject_id,selected_option,is_attempted) values($1,$2,$3,'A',true)",
        [f.session, other.questions[0], other.subject]), "23503");
    // Final states cannot change.
    assert.equal((await rpc("submit_exam_attempt", attempt(f))).status, "SUBMITTED");
    for (const status of ["BLOCKED", "IN_PROGRESS", "NOT_STARTED"]) {
        await rejectsWith(db.query("update exam_sessions set status=$2 where id=$1", [f.session, status]), "23514");
    }
    await rejectsWith(db.query("update exam_sessions set submitted_at=null where id=$1", [f.session]), "23514");
    const blocked = await fixture();
    assert.equal((await rpc("block_exam_attempt", { ...attempt(blocked), p_max_warnings: 3 })).blocked, true);
    await rejectsWith(db.query("update exam_sessions set status='IN_PROGRESS' where id=$1", [blocked.session]), "23514");
    await rejectsWith(db.query("update exam_sessions set status='SUBMITTED',submitted_at=now() where id=$1", [blocked.session]), "23514");
});

test("Proctoring block after submission leaves the attempt SUBMITTED; a running attempt is blocked", async () => {
    const f = await fixture();
    await answer(f, (await sequence(f))[0], "B");
    const submitted = await rpc("submit_exam_attempt", attempt(f));
    const block = await rpc("block_exam_attempt", { ...attempt(f), p_max_warnings: 3 });
    assert.deepEqual([block.status, block.blocked], ["SUBMITTED", false]);
    const state = await sessionState(f);
    assert.equal(state.status, "SUBMITTED");
    assert.equal(state.submitted_at.toISOString(), new Date(submitted.submittedAt).toISOString());

    const running = await fixture();
    const result = await rpc("block_exam_attempt", { ...attempt(running), p_max_warnings: 3 });
    assert.deepEqual([result.status, result.blocked, result.warningCount], ["BLOCKED", true, 3]);
    assert.equal((await answer(running, (await sequence(running))[0], "B")).code, "NOT_IN_PROGRESS");
    assert.equal((await rpc("submit_exam_attempt", attempt(running))).code, "NOT_IN_PROGRESS");
    // A device that no longer holds the lease cannot block anyone.
    const other = await fixture();
    assert.equal((await rpc("block_exam_attempt", { p_session_id: other.session, p_candidate_id: other.candidate,
        p_login_session_id: crypto.randomUUID(), p_max_warnings: 3 })).code, "ACTIVE_SESSION_REQUIRED");
    assert.equal((await sessionState(other)).status, "IN_PROGRESS");
});

test("Attempt creation is atomic: a failed initialization keeps no row and a retry creates one", async () => {
    const f = await fixture({ questions: 0, start: false });
    const failed = await rpc("start_exam_attempt", { ...f.args, p_exam_id: f.exam, p_class_id: f.cls, p_seconds_per_question: 60 });
    assert.equal(failed.code, "NO_QUESTIONS");
    assert.equal((await one("select count(*)::int n from exam_sessions where candidate_id=$1", [f.candidate])).n, 0);
    assert.equal((await one("select count(*)::int n from exam_attempt_questions q join exam_sessions s on s.id=q.session_id where s.candidate_id=$1", [f.candidate])).n, 0);

    await db.query("insert into questions(subject_id,question_number,question_text,option_a,option_b,option_c,option_d,correct_option) values($1,1,'Q','1','2','3','4','A')", [f.subject]);
    const retry = await rpc("start_exam_attempt", { ...f.args, p_exam_id: f.exam, p_class_id: f.cls, p_seconds_per_question: 60 });
    assert.equal(retry.created, true);
    assert.ok(retry.session.sequence_initialized_at);
    const again = await rpc("start_exam_attempt", { ...f.args, p_exam_id: f.exam, p_class_id: f.cls, p_seconds_per_question: 60 });
    assert.deepEqual([again.created, again.session.id], [false, retry.session.id]);
    assert.equal((await one("select count(*)::int n from exam_sessions where candidate_id=$1", [f.candidate])).n, 1);
    // Without the active device lease nothing is created.
    const stranger = await fixture({ start: false });
    const denied = await rpc("start_exam_attempt", { p_candidate_id: stranger.candidate, p_login_session_id: crypto.randomUUID(),
        p_exam_id: stranger.exam, p_class_id: stranger.cls, p_seconds_per_question: 60 });
    assert.equal(denied.code, "ACTIVE_SESSION_REQUIRED");
    assert.equal((await one("select count(*)::int n from exam_sessions where candidate_id=$1", [stranger.candidate])).n, 0);
});

test("The deadline is judged at execution time: just before is saved, at or after is finalized", async () => {
    const f = await fixture();
    const order = await sequence(f);
    await db.query("update exam_sessions set deadline_at=clock_timestamp()+interval '2 seconds' where id=$1", [f.session]);
    assert.equal((await answer(f, order[0], "B")).currentPosition, 1);
    await db.query("update exam_sessions set deadline_at=clock_timestamp() where id=$1", [f.session]);
    const late = await answer(f, order[1], "B");
    assert.deepEqual([late.timedOut, late.autoSubmitted, late.status], [true, true, "SUBMITTED"]);
    assert.equal((await one("select count(*)::int n from exam_answers where session_id=$1", [f.session])).n, 1, "the late answer is not stored");
    assert.equal((await answer(f, order[1], "C", false)).code, "NOT_IN_PROGRESS");
});

test("Admin lease release removes only the lease; the attempt is untouched and no token is involved", async () => {
    const f = await fixture();
    await db.query("insert into student_presence(candidate_id,stage) values($1,'IN_EXAM')", [f.candidate]);
    const released = await rpc("admin_release_student_login_session", { p_candidate_id: f.candidate });
    assert.equal(released.released, true);
    assert.equal(released.loginSessionId, undefined);
    assert.equal((await one("select count(*)::int n from student_login_sessions where candidate_id=$1", [f.candidate])).n, 0);
    assert.equal((await sessionState(f)).status, "IN_PROGRESS");
    assert.equal((await answer(f, (await sequence(f))[0], "B")).code, "ACTIVE_SESSION_REQUIRED", "the released device cannot write");
    assert.equal((await rpc("admin_release_student_login_session", { p_candidate_id: f.candidate })).released, false);
});

test("New functions are not executable by the browser roles", async () => {
    await db.exec("set role anon");
    try {
        for (const call of ["select block_exam_attempt(null,null,null,3)", "select start_exam_attempt(null,null,null,null,60)",
            "select admin_release_student_login_session(null)", "select admin_delete_exam_completely(null)"]) {
            await assert.rejects(db.query(call), /permission denied/);
        }
    } finally { await db.exec("reset role"); }
});

test("A full attempt lifecycle leaves the database consistent (production audit query returns zero)", async () => {
    const f = await fixture();
    const order = await sequence(f);
    await answer(f, order[0], "B", false);
    await answer(f, order[0], "B");
    await answer(f, order[1], null);
    const final = await answer(f, order[2], "C");
    assert.equal(final.status, "SUBMITTED");
    const state = await sessionState(f);
    assert.ok(state.submitted_at);
    assert.equal(state.current_position, 3);
    assert.equal(state.total_questions, 3);
    assert.equal((await one("select stage from student_presence where candidate_id=$1", [f.candidate])).stage, "COMPLETED");
    // Clear running attempts other tests deliberately left mid-way.
    await db.query("update exam_sessions set deadline_at=clock_timestamp()-interval '1 second' where status='IN_PROGRESS'");
    await rpc("expire_exam_attempts", { p_session_id: null });
    const { rows } = await db.query(AUDIT_SQL);
    assert.ok(rows.length >= 15);
    for (const row of rows) assert.equal(Number(row.violations), 0, row.check_name);
});
