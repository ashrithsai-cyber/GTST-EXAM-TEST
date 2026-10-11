-- Keep event-count polling bounded to the sessions currently displayed by
-- the admin monitor. Raw event timelines remain available through the
-- paginated /proctoring/events endpoint.
begin;

create or replace function admin_monitoring_event_summary(p_session_ids uuid[])
returns table (
    session_id uuid,
    event_counts jsonb,
    violation_count integer,
    latest_event_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select counts.session_id,
           jsonb_object_agg(counts.event_type, counts.event_count) as event_counts,
           sum(counts.event_count) filter (
               where counts.is_violation
           )::integer as violation_count,
           max(counts.latest_event_at) as latest_event_at
    from (
        select ev.session_id,
               ev.event_type,
               count(*)::integer as event_count,
               bool_or(coalesce(ev.is_violation,
                   ev.event_type not in ('NETWORK_DISCONNECT', 'NETWORK_RECONNECT'))) as is_violation,
               max(ev.created_at) as latest_event_at
        from exam_events ev
        where ev.session_id = any(coalesce(p_session_ids, '{}'::uuid[]))
        group by ev.session_id, ev.event_type
    ) counts
    group by counts.session_id
$$;

create or replace function admin_exam_attempt_progress(p_session_ids uuid[])
returns table (
    session_id uuid,
    attempted integer,
    total integer,
    current_subject text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with snapshot_totals as (
        select q.session_id, count(*)::integer as total
        from exam_attempt_questions q
        where q.session_id = any(coalesce(p_session_ids, '{}'::uuid[]))
        group by q.session_id
    )
    select s.id,
           least(s.current_position, coalesce(t.total, 0))::integer,
           coalesce(t.total, 0),
           case
               when coalesce(t.total, 0) = 0 then null
               when s.status = 'SUBMITTED' or s.current_position >= t.total then 'Completed'
               else current_question.subject_name
           end
    from exam_sessions s
    left join snapshot_totals t on t.session_id = s.id
    left join lateral (
        select q.subject_name
        from exam_attempt_questions q
        where q.session_id = s.id and q.position = s.current_position
    ) current_question on true
    where s.id = any(coalesce(p_session_ids, '{}'::uuid[]))
$$;

revoke all on function admin_monitoring_event_summary(uuid[]) from public, anon, authenticated;
grant execute on function admin_monitoring_event_summary(uuid[]) to service_role;
revoke all on function admin_exam_attempt_progress(uuid[]) from public, anon, authenticated;
grant execute on function admin_exam_attempt_progress(uuid[]) to service_role;

commit;
