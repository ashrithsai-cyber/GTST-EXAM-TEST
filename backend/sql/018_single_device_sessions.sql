-- Apply to the dedicated exam database AFTER 017_sequential_attempts.sql.
-- No registration-project or production data is changed by the application.
-- One bounded row per candidate is the active device lease. The ten-minute
-- idle grace survives refresh and a temporary network failure. Expired rows
-- are reclaimed atomically at the next login; logout deletes only its own ID.
begin;

create table if not exists public.student_login_sessions (
    candidate_id uuid primary key references public.exam_candidates(id) on delete cascade,
    login_session_id uuid not null unique,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null,
    token_expires_at timestamptz not null
);
create index if not exists student_login_sessions_expiry on public.student_login_sessions(expires_at);
alter table public.student_login_sessions enable row level security;
revoke all on public.student_login_sessions from anon, authenticated;
grant all on public.student_login_sessions to service_role;

create or replace function public.acquire_student_login_session(
    p_candidate_id uuid, p_login_session_id uuid, p_token_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    v_session public.student_login_sessions%rowtype;
    v_now timestamptz;
    v_inserted integer;
    v_resumed boolean;
begin
    if p_candidate_id is null or p_login_session_id is null
       or p_token_expires_at is null or p_token_expires_at <= clock_timestamp() then
        return jsonb_build_object('active', false);
    end if;
    -- ON CONFLICT waits for a competing login's insert, then the row lock
    -- serializes both requests. Only the winner ever receives a token.
    loop
        insert into public.student_login_sessions(candidate_id, login_session_id, expires_at, token_expires_at)
        values(p_candidate_id, p_login_session_id, clock_timestamp() + interval '10 minutes', p_token_expires_at)
        on conflict(candidate_id) do nothing;
        get diagnostics v_inserted = row_count;
        select * into v_session from public.student_login_sessions
        where candidate_id = p_candidate_id for update;
        exit when found;
        -- A logout may delete a conflicting row between INSERT and
        -- SELECT. Retry instead of issuing a token without a lease.
    end loop;
    v_now := clock_timestamp();
    v_resumed := v_inserted = 0 and v_session.login_session_id = p_login_session_id;
    if v_session.login_session_id <> p_login_session_id
       and v_session.expires_at > v_now and v_session.token_expires_at > v_now then
        return jsonb_build_object('active', false);
    end if;
    update public.student_login_sessions set
        login_session_id = p_login_session_id,
        created_at = case when v_session.login_session_id = p_login_session_id then created_at else v_now end,
        last_seen_at = v_now,
        token_expires_at = case when v_session.login_session_id = p_login_session_id
            then greatest(token_expires_at, p_token_expires_at) else p_token_expires_at end,
        expires_at = least(v_now + interval '10 minutes', p_token_expires_at)
    where candidate_id = p_candidate_id
    returning * into v_session;
    return jsonb_build_object('active', true, 'resumed', v_resumed,
        'expiresAt', v_session.expires_at, 'serverTime', v_now);
end;
$$;

create or replace function public.touch_student_login_session(
    p_candidate_id uuid, p_login_session_id uuid, p_token_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    v_session public.student_login_sessions%rowtype;
    v_now timestamptz;
begin
    select * into v_session from public.student_login_sessions
    where candidate_id = p_candidate_id for update;
    v_now := clock_timestamp();
    if not found or v_session.login_session_id <> p_login_session_id
       or v_session.expires_at <= v_now or v_session.token_expires_at <= v_now
       or p_token_expires_at is null or p_token_expires_at <= v_now then
        return jsonb_build_object('active', false);
    end if;
    -- Do not rewrite presence/lease for every image, proctoring event or
    -- answer. Any request validates the row; only one per 15s renews it.
    if v_session.last_seen_at <= v_now - interval '15 seconds'
       or p_token_expires_at > v_session.token_expires_at then
        update public.student_login_sessions set last_seen_at = v_now,
            token_expires_at = greatest(token_expires_at, p_token_expires_at),
            expires_at = least(v_now + interval '10 minutes', greatest(token_expires_at, p_token_expires_at))
        where candidate_id = p_candidate_id returning * into v_session;
        update public.student_presence set updated_at = v_now where candidate_id = p_candidate_id;
    end if;
    return jsonb_build_object('active', true, 'expiresAt', v_session.expires_at, 'serverTime', v_now);
end;
$$;

create or replace function public.release_student_login_session(
    p_candidate_id uuid, p_login_session_id uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_released integer;
begin
    delete from public.student_login_sessions
    where candidate_id = p_candidate_id and login_session_id = p_login_session_id;
    get diagnostics v_released = row_count;
    if v_released > 0 then
        update public.student_presence set updated_at = '1970-01-01T00:00:00Z'
        where candidate_id = p_candidate_id and stage <> 'COMPLETED';
    end if;
    return v_released > 0;
end;
$$;

-- Replaces 017's fail-closed guard. A transaction must lock the login
-- row BEFORE the exam row. It holds this lock until answers/submission
-- commit, so a device that passed middleware cannot save after takeover.
create or replace function public.assert_exam_login_session(
    p_candidate_id uuid, p_login_session_id uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_session public.student_login_sessions%rowtype;
begin
    if p_candidate_id is null or p_login_session_id is null then return false; end if;
    select * into v_session from public.student_login_sessions
    where candidate_id = p_candidate_id for update;
    return found and v_session.login_session_id = p_login_session_id
        and v_session.expires_at > clock_timestamp() and v_session.token_expires_at > clock_timestamp();
end;
$$;

revoke all on function public.acquire_student_login_session(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.touch_student_login_session(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.release_student_login_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assert_exam_login_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.acquire_student_login_session(uuid, uuid, timestamptz) to service_role;
grant execute on function public.touch_student_login_session(uuid, uuid, timestamptz) to service_role;
grant execute on function public.release_student_login_session(uuid, uuid) to service_role;
grant execute on function public.assert_exam_login_session(uuid, uuid) to service_role;

commit;
