-- Additive upgrade from 019. Apply on staging first, before the matching
-- backend. No existing rows are deleted or rewritten. The old backend
-- remains compatible. Never replay 001-019 as part of this upgrade.
begin;
alter table exam_events add column if not exists client_event_id uuid;
alter table exam_events add column if not exists occurred_at timestamptz;
alter table exam_events add column if not exists is_violation boolean;
create unique index if not exists exam_events_client_event_unique on exam_events(session_id, client_event_id)
    where client_event_id is not null;
create index if not exists exam_events_session_created on exam_events(session_id, created_at desc, id);

create or replace function record_exam_event(
    p_session_id uuid, p_candidate_id uuid, p_login_session_id uuid,
    p_client_event_id uuid, p_event_type text, p_event_message text,
    p_occurred_at timestamptz, p_is_violation boolean
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s exam_sessions%rowtype; ev exam_events%rowtype; stamp timestamptz; observed timestamptz;
begin
    if not assert_exam_login_session(p_candidate_id, p_login_session_id) then
        return jsonb_build_object('code','ACTIVE_SESSION_REQUIRED');
    end if;
    select * into s from exam_sessions where id=p_session_id for update;
    if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
    if s.candidate_id<>p_candidate_id then return jsonb_build_object('code','FORBIDDEN'); end if;
    if p_event_type not in ('MULTIPLE_FACE','NO_FACE','CAMERA_DISABLED','MICROPHONE_DISABLED',
        'TAB_SWITCH','WINDOW_BLUR','FULLSCREEN_EXIT','RIGHT_CLICK','COPY_PASTE',
        'NETWORK_DISCONNECT','NETWORK_RECONNECT','EXAM_LEFT') then
        return jsonb_build_object('code','INVALID_EVENT');
    end if;
    if p_client_event_id is not null then
        select * into ev from exam_events where session_id=s.id and client_event_id=p_client_event_id;
        if found then
            return jsonb_build_object('success',true,'recorded',true,'duplicate',true,'eventId',ev.id,
                'violation',ev.is_violation,'violationCount',s.proctoring_warning_count,'blocked',false);
        end if;
    end if;
    stamp:=clock_timestamp(); observed:=coalesce(p_occurred_at,stamp);
    if observed>stamp+interval '30 seconds' or observed<coalesce(s.started_at,s.created_at)-interval '30 seconds' then
        return jsonb_build_object('code','INVALID_EVENT_TIME');
    end if;
    -- A delayed report captured before voluntary submission may arrive
    -- after it. Client time is telemetry, never authority for answers/timers.
    if s.status<>'IN_PROGRESS' and not (s.status='SUBMITTED' and p_client_event_id is not null
        and p_occurred_at is not null and observed<=s.submitted_at) then
        return jsonb_build_object('code','NOT_IN_PROGRESS','status',s.status);
    end if;
    insert into exam_events(session_id,event_type,event_message,warning_number,client_event_id,occurred_at,is_violation)
    values(s.id,p_event_type,left(p_event_message,500),null,p_client_event_id,observed,coalesce(p_is_violation,false))
    returning * into ev;
    if coalesce(p_is_violation,false) then
        update exam_sessions set proctoring_warning_count=proctoring_warning_count+1
        where id=s.id returning * into s;
    end if;
    return jsonb_build_object('success',true,'recorded',true,'eventId',ev.id,
        'violation',ev.is_violation,'violationCount',s.proctoring_warning_count,'blocked',false);
end $$;
revoke all on function record_exam_event(uuid,uuid,uuid,uuid,text,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function record_exam_event(uuid,uuid,uuid,uuid,text,text,timestamptz,boolean) to service_role;
commit;
