-- Permanently delete one inactive exam and all exam-scoped records.
-- Candidate/registration records and data for other exams are retained.
begin;

create or replace function public.admin_delete_exam_completely(p_exam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    target_exam public.exams%rowtype;
    screenshot_paths jsonb;
    attempt_count integer;
    answer_count integer;
    event_count integer;
    screenshot_count integer;
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

    if exists (
        select 1 from public.exam_sessions
        where exam_id = p_exam_id and status = 'IN_PROGRESS'
    ) then
        return jsonb_build_object('code', 'EXAM_HAS_ACTIVE_ATTEMPTS');
    end if;

    select coalesce(jsonb_agg(storage_path), '[]'::jsonb),
           count(*)::integer
    into screenshot_paths, screenshot_count
    from public.system_check_screenshots
    where exam_id = p_exam_id;

    select count(*)::integer into attempt_count
    from public.exam_sessions where exam_id = p_exam_id;
    select count(*)::integer into answer_count
    from public.exam_answers a
    join public.exam_sessions s on s.id = a.session_id
    where s.exam_id = p_exam_id;
    select count(*)::integer into event_count
    from public.exam_events e
    join public.exam_sessions s on s.id = e.session_id
    where s.exam_id = p_exam_id;

    delete from public.system_check_screenshots where exam_id = p_exam_id;
    delete from public.exam_sessions where exam_id = p_exam_id;
    delete from public.exams where id = p_exam_id;

    return jsonb_build_object(
        'success', true,
        'examId', p_exam_id,
        'deletedAttempts', attempt_count,
        'deletedAnswers', answer_count,
        'deletedEvents', event_count,
        'deletedCheckInPhotos', screenshot_count,
        'screenshotPaths', screenshot_paths
    );
end
$$;

revoke all on function public.admin_delete_exam_completely(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_exam_completely(uuid) to service_role;

commit;
