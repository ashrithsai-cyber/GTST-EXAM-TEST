-- Apply to the dedicated exam database AFTER 018_single_device_sessions.sql,
-- then restart the backend. Idempotent. No existing rows are modified.
--
-- 1. SUBMITTED and BLOCKED are final attempt states, enforced by trigger.
-- 2. block_exam_attempt: the proctoring block takes the same lease ->
--    attempt row locks as answer/submit, so a submit can never be undone.
-- 3. start_exam_attempt: creates and initializes an attempt in one
--    transaction; a failed initialization leaves no session row behind.
-- 4. Answers must reference a question in the attempt's own sequence.
-- 5. admin_release_student_login_session: an admin may clear a stuck
--    device lease. It never issues a token; the student must log in.
begin;

-- ---------------------------------------------------------------------
-- 1. Final attempt states
-- ---------------------------------------------------------------------
create or replace function guard_exam_session_status()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.status is distinct from old.status
       and (old.status in ('SUBMITTED','BLOCKED') or new.status = 'NOT_STARTED') then
        raise exception 'Exam attempt status % is final and cannot change to %', old.status, new.status
            using errcode = 'check_violation';
    end if;
    return new;
end $$;

drop trigger if exists exam_sessions_status_guard on exam_sessions;
create trigger exam_sessions_status_guard
    before update of status on exam_sessions
    for each row execute function guard_exam_session_status();

-- A submitted attempt always records its completion time. Added NOT VALID
-- so legacy rows cannot block deployment; validated when they comply.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'exam_sessions_submitted_at_required') then
        alter table exam_sessions add constraint exam_sessions_submitted_at_required
            check (status <> 'SUBMITTED' or submitted_at is not null) not valid;
    end if;
    if not exists (select 1 from exam_sessions where status = 'SUBMITTED' and submitted_at is null) then
        alter table exam_sessions validate constraint exam_sessions_submitted_at_required;
    else
        raise notice 'exam_sessions_submitted_at_required left NOT VALID: legacy SUBMITTED rows lack submitted_at.';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Proctoring block under the attempt lock
-- ---------------------------------------------------------------------
create or replace function block_exam_attempt(p_session_id uuid, p_candidate_id uuid,
    p_login_session_id uuid, p_max_warnings integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s exam_sessions%rowtype;
begin
    if not assert_exam_login_session(p_candidate_id, p_login_session_id) then
        return jsonb_build_object('code','ACTIVE_SESSION_REQUIRED');
    end if;
    select * into s from exam_sessions where id = p_session_id for update;
    if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
    if s.candidate_id <> p_candidate_id then return jsonb_build_object('code','FORBIDDEN'); end if;
    if s.status in ('IN_PROGRESS','NOT_STARTED') then
        update exam_sessions set status = 'BLOCKED', last_activity_at = clock_timestamp(),
            question_started_at = null,
            proctoring_warning_count = greatest(proctoring_warning_count, p_max_warnings)
        where id = s.id returning * into s;
    end if;
    return jsonb_build_object('status', s.status, 'blocked', s.status = 'BLOCKED',
        'warningCount', s.proctoring_warning_count, 'submittedAt', s.submitted_at);
end $$;

-- ---------------------------------------------------------------------
-- 3. Atomic attempt creation
-- ---------------------------------------------------------------------
create or replace function start_exam_attempt(p_candidate_id uuid, p_login_session_id uuid,
    p_exam_id uuid, p_class_id uuid, p_seconds_per_question integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s exam_sessions%rowtype; v_id uuid; v_state jsonb; v_stamp timestamptz;
begin
    -- The lease row lock serializes concurrent starts for one candidate.
    if not assert_exam_login_session(p_candidate_id, p_login_session_id) then
        return jsonb_build_object('code','ACTIVE_SESSION_REQUIRED');
    end if;
    select * into s from exam_sessions where candidate_id = p_candidate_id and exam_id = p_exam_id;
    if found then return jsonb_build_object('created', false, 'session', to_jsonb(s)); end if;
    begin
        v_stamp := clock_timestamp();
        insert into exam_sessions(candidate_id, exam_id, class_id, status, current_subject_index,
            current_question_index, seconds_per_question, started_at, question_started_at, last_activity_at)
        values (p_candidate_id, p_exam_id, p_class_id, 'IN_PROGRESS', 0, 0, p_seconds_per_question,
            v_stamp, v_stamp, v_stamp)
        returning id into v_id;
        v_state := init_exam_attempt(v_id, p_candidate_id, p_login_session_id);
        if v_state ? 'code' then
            -- Roll back the session row; the student may retry cleanly.
            raise exception using errcode = 'P0001', message = 'GTST_ATTEMPT_INIT:' || (v_state->>'code');
        end if;
        return jsonb_build_object('created', true, 'session', v_state);
    exception
        when unique_violation then
            select * into s from exam_sessions where candidate_id = p_candidate_id and exam_id = p_exam_id;
            if found then return jsonb_build_object('created', false, 'session', to_jsonb(s)); end if;
            return jsonb_build_object('code','OTHER_ATTEMPT_IN_PROGRESS');
        when raise_exception then
            if sqlerrm like 'GTST_ATTEMPT_INIT:%' then
                return jsonb_build_object('code', substr(sqlerrm, length('GTST_ATTEMPT_INIT:') + 1));
            end if;
            raise;
    end;
end $$;

-- ---------------------------------------------------------------------
-- 4. Answers reference the attempt's own sequence
-- ---------------------------------------------------------------------
-- NOT VALID enforces every new or re-keyed answer immediately. Existing
-- rows are validated only when they all comply: answers from attempts
-- submitted before 017 have no snapshot rows and are retained as-is.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'exam_answers_attempt_question_fkey') then
        alter table exam_answers add constraint exam_answers_attempt_question_fkey
            foreign key (session_id, question_id)
            references exam_attempt_questions(session_id, question_id) on delete cascade not valid;
    end if;
    if not exists (
        select 1 from exam_answers a where not exists (
            select 1 from exam_attempt_questions q
            where q.session_id = a.session_id and q.question_id = a.question_id)
    ) then
        alter table exam_answers validate constraint exam_answers_attempt_question_fkey;
    else
        raise notice 'exam_answers_attempt_question_fkey left NOT VALID: legacy answers predate attempt snapshots.';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Admin release of a stuck device lease
-- ---------------------------------------------------------------------
create or replace function admin_release_student_login_session(p_candidate_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_session student_login_sessions%rowtype;
begin
    delete from student_login_sessions where candidate_id = p_candidate_id returning * into v_session;
    if not found then return jsonb_build_object('released', false); end if;
    update student_presence set updated_at = '1970-01-01T00:00:00Z'
        where candidate_id = p_candidate_id and stage <> 'COMPLETED';
    return jsonb_build_object('released', true, 'createdAt', v_session.created_at,
        'lastSeenAt', v_session.last_seen_at, 'expiresAt', v_session.expires_at);
end $$;

revoke all on function guard_exam_session_status() from public, anon, authenticated;
revoke all on function block_exam_attempt(uuid, uuid, uuid, integer),
    start_exam_attempt(uuid, uuid, uuid, uuid, integer),
    admin_release_student_login_session(uuid) from public, anon, authenticated;
grant execute on function block_exam_attempt(uuid, uuid, uuid, integer),
    start_exam_attempt(uuid, uuid, uuid, uuid, integer),
    admin_release_student_login_session(uuid) to service_role;
commit;
