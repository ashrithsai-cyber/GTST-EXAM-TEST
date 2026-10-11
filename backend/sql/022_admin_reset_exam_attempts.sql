-- Admin-only reset for one inactive exam. Attempts and their dependent
-- answers, scores, question snapshots, and events are removed atomically.
-- Registration/candidate/question data and stored check-in images remain.
begin;

create or replace function public.admin_reset_exam_attempts(p_exam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    target_exam public.exams%rowtype;
    candidate_ids uuid[];
    attempt_ids uuid[];
    attempt_count integer;
    answer_count integer;
    event_count integer;
    lease_count integer;
    preflight_count integer;
    presence_count integer;
begin
    select * into target_exam
    from public.exams
    where id = p_exam_id
    for update;

    if not found then
        return jsonb_build_object('code', 'EXAM_NOT_FOUND');
    end if;

    if target_exam.status = 'ACTIVE' then
        return jsonb_build_object('code', 'EXAM_ACTIVE');
    end if;

    select coalesce(array_agg(s.id), '{}'::uuid[]),
           count(*)::integer
    into attempt_ids, attempt_count
    from public.exam_sessions s
    where s.exam_id = p_exam_id;

    if exists (
        select 1 from public.exam_sessions s
        where s.exam_id = p_exam_id and s.status = 'IN_PROGRESS'
    ) then
        return jsonb_build_object('code', 'EXAM_HAS_ACTIVE_ATTEMPTS');
    end if;

    select coalesce(array_agg(distinct c.id), '{}'::uuid[])
    into candidate_ids
    from public.exam_candidates c
    where exists (
        select 1
        from public.classes cl
        where cl.exam_id = p_exam_id
          and nullif(regexp_replace(cl.class_name, '\D', '', 'g'), '')::integer
              = nullif(regexp_replace(c.student_class, '\D', '', 'g'), '')::integer
    )
    or exists (
        select 1 from public.exam_sessions s
        where s.exam_id = p_exam_id and s.candidate_id = c.id
    )
    or exists (
        select 1 from public.exam_preflight p
        where p.exam_id = p_exam_id and p.candidate_id = c.id
    );

    if exists (
        select 1 from public.exam_sessions s
        where s.candidate_id = any(candidate_ids)
          and s.exam_id <> p_exam_id
          and s.status = 'IN_PROGRESS'
    ) then
        return jsonb_build_object('code', 'CANDIDATE_ACTIVE_IN_ANOTHER_EXAM');
    end if;

    select count(*)::integer into answer_count
    from public.exam_answers where session_id = any(attempt_ids);
    select count(*)::integer into event_count
    from public.exam_events where session_id = any(attempt_ids);

    update public.system_check_screenshots
    set session_id = null
    where session_id = any(attempt_ids);

    delete from public.exam_sessions where id = any(attempt_ids);

    delete from public.exam_preflight where exam_id = p_exam_id;
    get diagnostics preflight_count = row_count;

    delete from public.student_login_sessions
    where candidate_id = any(candidate_ids);
    get diagnostics lease_count = row_count;

    delete from public.student_presence
    where candidate_id = any(candidate_ids);
    get diagnostics presence_count = row_count;

    return jsonb_build_object(
        'success', true,
        'examId', p_exam_id,
        'candidateCount', cardinality(candidate_ids),
        'deletedAttempts', attempt_count,
        'deletedAnswers', answer_count,
        'deletedEvents', event_count,
        'releasedLoginSessions', lease_count,
        'clearedPreflightRecords', preflight_count,
        'clearedPresenceRecords', presence_count
    );
end
$$;

revoke all on function public.admin_reset_exam_attempts(uuid) from public, anon, authenticated;
grant execute on function public.admin_reset_exam_attempts(uuid) to service_role;

commit;
