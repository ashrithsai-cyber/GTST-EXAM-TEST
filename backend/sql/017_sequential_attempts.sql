-- Run after 001-016 and immediately before 018_single_device_sessions.sql.
-- Apply both migrations before restarting the backend. No production rows
-- are removed. Existing attempts are snapshotted when first resumed.
begin;

alter table exams add column if not exists randomize_questions boolean not null default false;
alter table exam_sessions add column if not exists sequence_initialized_at timestamptz;
alter table exam_sessions add column if not exists current_position integer not null default 0;
alter table exam_sessions add column if not exists total_questions integer;
alter table exam_sessions add column if not exists deadline_at timestamptz;

-- Private immutable question snapshot, including its server-only answer key.
-- Restrictive question/subject FKs retain the audit trail after submission.
create table if not exists exam_attempt_questions (
    session_id uuid not null references exam_sessions(id) on delete cascade,
    position integer not null check (position >= 0),
    question_id uuid not null references questions(id),
    subject_id uuid not null references subjects(id),
    subject_index integer not null check (subject_index >= 0),
    question_index integer not null check (question_index >= 0),
    subject_key text not null,
    subject_name text not null,
    question_number integer not null,
    question_text text not null,
    passage text,
    option_a text not null,
    option_b text not null,
    option_c text not null,
    option_d text not null,
    correct_option char(1) not null check (correct_option in ('A','B','C','D')),
    marks integer not null,
    primary key (session_id, position),
    unique (session_id, question_id),
    unique (session_id, subject_index, question_index)
);
alter table exam_attempt_questions enable row level security;
revoke all on exam_attempt_questions from anon, authenticated;
create index if not exists idx_exam_sessions_deadline
    on exam_sessions(deadline_at) where status = 'IN_PROGRESS';

-- Migration 018 replaces this fail-closed stub with the active device lease
-- validator. Lock order is always login lease, then attempt.
create or replace function assert_exam_login_session(p_candidate_id uuid, p_login_session_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin return false; end $$;

create or replace function init_exam_attempt(p_session_id uuid, p_candidate_id uuid, p_login_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    s exam_sessions%rowtype;
    e exams%rowtype;
    total integer;
    initial_position integer;
    first_q exam_attempt_questions%rowtype;
    cap timestamptz;
begin
    if not assert_exam_login_session(p_candidate_id,p_login_session_id) then
        return jsonb_build_object('code','ACTIVE_SESSION_REQUIRED');
    end if;
    select * into s from exam_sessions where id = p_session_id for update;
    if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
    if s.candidate_id <> p_candidate_id then return jsonb_build_object('code','FORBIDDEN'); end if;
    if s.sequence_initialized_at is not null then return to_jsonb(s); end if;
    if s.status <> 'IN_PROGRESS' then return to_jsonb(s); end if;
    select * into e from exams where id = s.exam_id;
    if not exists(select 1 from classes where id=s.class_id and exam_id=s.exam_id) then
        return jsonb_build_object('code','INVALID_EXAM_CLASS');
    end if;
    -- Generate each random rank exactly once, retaining subject boundaries.
    -- Legacy running attempts retain their existing ordered pointer.
    insert into exam_attempt_questions
        (session_id,position,question_id,subject_id,subject_index,question_index,
         subject_key,subject_name,question_number,question_text,passage,
         option_a,option_b,option_c,option_d,correct_option,marks)
    with ranked_subjects as (
        select sub.*, (row_number() over(order by display_order,id)-1)::integer as si
        from subjects sub where class_id=s.class_id
    ), ranked_questions as (
        select q.*, sub.si, sub.subject_key, sub.subject_name,
            row_number() over(partition by sub.id order by
                case when e.randomize_questions and s.current_subject_index=0 and s.current_question_index=0
                     and not exists(select 1 from exam_answers where session_id=s.id)
                     then random() else 0 end, q.question_number,q.id)-1 as qi
        from questions q join ranked_subjects sub on sub.id=q.subject_id
        where q.status='ACTIVE'
    )
    select s.id,(row_number() over(order by si,qi)-1)::integer,id,subject_id,si,qi::integer,
        subject_key,subject_name,question_number,question_text,passage,
        option_a,option_b,option_c,option_d,correct_option,marks
    from ranked_questions;
    select count(*) into total from exam_attempt_questions where session_id=s.id;
    if total=0 then
        return jsonb_build_object('code','NO_QUESTIONS');
    end if;
    select position into initial_position from exam_attempt_questions
        where session_id=s.id and subject_index=s.current_subject_index and question_index=s.current_question_index;
    initial_position := coalesce(initial_position,case when s.current_subject_index=0 and s.current_question_index=0 then 0 else total end);
    select * into first_q from exam_attempt_questions where session_id=s.id and position=initial_position;
    cap := coalesce(s.started_at,clock_timestamp()) + make_interval(secs => total * greatest(coalesce(s.seconds_per_question,e.seconds_per_question),1));
    if e.exam_start_at is not null and e.duration_minutes is not null then
        cap := least(cap,e.exam_start_at + make_interval(mins => e.duration_minutes));
    end if;
    update exam_sessions set sequence_initialized_at=clock_timestamp(),
        total_questions=total,current_position=initial_position,deadline_at=cap,
        max_score=(select sum(marks) from exam_attempt_questions where session_id=s.id),
        seconds_per_question=greatest(coalesce(s.seconds_per_question,e.seconds_per_question),1),
        current_subject_index=coalesce(first_q.subject_index,s.current_subject_index),
        current_question_index=coalesce(first_q.question_index,s.current_question_index),
        question_started_at=case when initial_position<total then coalesce(s.question_started_at,clock_timestamp()) else null end
    where id=s.id returning * into s;
    return to_jsonb(s);
end $$;

-- Internal finalization called only while the attempt row is locked.
create or replace function finalize_exam_attempt(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s exam_sessions%rowtype; score numeric; maximum numeric; attempted integer;
begin
    select * into s from exam_sessions where id=p_session_id for update;
    if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
    if s.status not in ('IN_PROGRESS','SUBMITTED') then return jsonb_build_object('code','NOT_IN_PROGRESS','status',s.status); end if;
    if s.sequence_initialized_at is null then return jsonb_build_object('code','SEQUENCE_REQUIRED'); end if;
    select coalesce(sum(case when a.selected_option=q.correct_option then q.marks else 0 end),0),
        coalesce(sum(q.marks),0),count(a.selected_option)
    into score,maximum,attempted from exam_attempt_questions q
        left join exam_answers a on a.session_id=q.session_id and a.question_id=q.question_id
        where q.session_id=s.id;
    if s.status='IN_PROGRESS' then
        update exam_sessions set status='SUBMITTED',submitted_at=clock_timestamp(),
            last_activity_at=clock_timestamp(),question_started_at=null,
            total_score=score,max_score=maximum where id=s.id returning * into s;
        insert into student_presence(candidate_id,stage,updated_at) values(s.candidate_id,'COMPLETED',clock_timestamp())
            on conflict(candidate_id) do update set stage='COMPLETED',updated_at=excluded.updated_at;
    end if;
    return jsonb_build_object('status',s.status,'submittedAt',s.submitted_at,'attemptedCount',attempted,'totalQuestions',s.total_questions);
end $$;

create or replace function save_exam_answer(p_session_id uuid,p_candidate_id uuid,p_login_session_id uuid,
    p_question_id uuid,p_selected_option text,p_advance boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s exam_sessions%rowtype; q exam_attempt_questions%rowtype; nq exam_attempt_questions%rowtype;
    stamp timestamptz; expired boolean; opt text; previous_option text; had_answer boolean; result jsonb;
begin
    if not assert_exam_login_session(p_candidate_id,p_login_session_id) then
        return jsonb_build_object('code','ACTIVE_SESSION_REQUIRED');
    end if;
    select * into s from exam_sessions where id=p_session_id for update;
    if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
    if s.candidate_id<>p_candidate_id then return jsonb_build_object('code','FORBIDDEN'); end if;
    if p_selected_option is not null and p_selected_option not in ('A','B','C','D') then
        return jsonb_build_object('code','INVALID_OPTION');
    end if;
    if s.status<>'IN_PROGRESS' then
        return jsonb_build_object('code','NOT_IN_PROGRESS','status',s.status);
    end if;
    if s.sequence_initialized_at is null then return jsonb_build_object('code','SEQUENCE_REQUIRED'); end if;
    stamp:=clock_timestamp();
    if stamp>=s.deadline_at then
        return finalize_exam_attempt(s.id) || jsonb_build_object('autoSubmitted',true,'examComplete',true,'timedOut',true);
    end if;
    select * into q from exam_attempt_questions where session_id=s.id and position=s.current_position;
    if not found or q.question_id<>p_question_id then return jsonb_build_object('code','STALE_QUESTION'); end if;
    expired:=stamp>=s.question_started_at+make_interval(secs=>s.seconds_per_question);
    select selected_option into previous_option from exam_answers where session_id=s.id and question_id=q.question_id;
    had_answer:=found;
    -- A timely draft is retained on timeout. A new late selection cannot
    -- replace it. Null on an advance means retain the already saved draft.
    opt:=case when expired then previous_option when p_advance and p_selected_option is null and had_answer then previous_option else p_selected_option end;
    if expired and not p_advance then return jsonb_build_object('code','QUESTION_EXPIRED'); end if;
    insert into exam_answers(session_id,question_id,subject_id,selected_option,is_attempted,is_correct,time_spent_seconds,answered_at)
    values(s.id,q.question_id,q.subject_id,opt,opt is not null,coalesce(opt=q.correct_option,false),
        greatest(0,least(s.seconds_per_question,floor(extract(epoch from stamp-s.question_started_at))::integer)),stamp)
    on conflict(session_id,question_id) do update set selected_option=excluded.selected_option,
        is_attempted=excluded.is_attempted,is_correct=excluded.is_correct,
        time_spent_seconds=excluded.time_spent_seconds,answered_at=excluded.answered_at;
    if not p_advance then
        update exam_sessions set last_activity_at=stamp where id=s.id;
        return jsonb_build_object('status','IN_PROGRESS','selectedOption',opt,'serverTime',stamp);
    end if;
    select * into nq from exam_attempt_questions where session_id=s.id and position=s.current_position+1;
    update exam_sessions set current_position=current_position+1,
        current_subject_index=coalesce(nq.subject_index,s.current_subject_index+1),
        current_question_index=coalesce(nq.question_index,0),
        question_started_at=case when nq.question_id is not null then stamp else null end,last_activity_at=stamp
        where id=s.id returning * into s;
    result:=jsonb_build_object('status',s.status,'currentPosition',s.current_position,
        'nextSubjectIndex',nq.subject_index,'nextQuestionIndex',nq.question_index,
        'sectionComplete',nq.subject_index is not null and nq.subject_index<>q.subject_index,
        'examComplete',nq.question_id is null,'timedOut',expired,'serverTime',stamp,'session',to_jsonb(s));
    if nq.question_id is null then
        result:=result || finalize_exam_attempt(s.id) || jsonb_build_object('autoSubmitted',true);
    end if;
    return result;
end $$;

create or replace function submit_exam_attempt(p_session_id uuid,p_candidate_id uuid,p_login_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s exam_sessions%rowtype;
begin
    if not assert_exam_login_session(p_candidate_id,p_login_session_id) then return jsonb_build_object('code','ACTIVE_SESSION_REQUIRED'); end if;
    select * into s from exam_sessions where id=p_session_id for update;
    if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
    if s.candidate_id<>p_candidate_id then return jsonb_build_object('code','FORBIDDEN'); end if;
    return finalize_exam_attempt(s.id);
end $$;

-- Server cleanup has no student/device input and may finalize only overdue
-- attempts. A repeated cleanup or a concurrent answer is harmless.
create or replace function expire_exam_attempts(p_session_id uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare attempt record; closed integer:=0;
begin
    for attempt in select id from exam_sessions where status='IN_PROGRESS' and deadline_at<=clock_timestamp()
        and (p_session_id is null or id=p_session_id) order by deadline_at,id limit 500 for update skip locked loop
        perform finalize_exam_attempt(attempt.id); closed:=closed+1;
    end loop;
    return closed;
end $$;

revoke all on function assert_exam_login_session(uuid,uuid),init_exam_attempt(uuid,uuid,uuid),
    finalize_exam_attempt(uuid),save_exam_answer(uuid,uuid,uuid,uuid,text,boolean),
    submit_exam_attempt(uuid,uuid,uuid),expire_exam_attempts(uuid) from public,anon,authenticated;
grant execute on function assert_exam_login_session(uuid,uuid),init_exam_attempt(uuid,uuid,uuid),
    save_exam_answer(uuid,uuid,uuid,uuid,text,boolean),submit_exam_attempt(uuid,uuid,uuid),expire_exam_attempts(uuid) to service_role;
commit;
