-- =====================================================================
-- 014 — production hardening: server-side preflight, result
-- publication, per-session timer snapshot, private screenshot bucket.
--
-- Run once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-013. Additive and idempotent — safe to re-run, drops
-- no data.
--
-- DEPLOY ORDER: run this BEFORE (or together with) restarting the
-- updated backend. The backend refuses to create NEW exam sessions
-- until exam_preflight exists (it fails closed rather than letting a
-- student skip System Check); already IN_PROGRESS sessions keep
-- resuming normally either way.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- exam_preflight — the server-side record of System Check -> Proctoring
-- Rules completion, one row per (candidate, exam). POST
-- /api/exam/session/start refuses to create a session until
-- system_check_completed_at and rules_accepted_at are both set (and, when
-- the camera is required, a check-in screenshot exists). Written only by
-- the backend (service_role); the *_check columns record which
-- requirements the student's browser reported as satisfied at the time.
-- ---------------------------------------------------------------------
create table if not exists exam_preflight (
    id                         uuid primary key default gen_random_uuid(),
    candidate_id               uuid not null references exam_candidates(id) on delete cascade,
    exam_id                    uuid not null references exams(id) on delete cascade,
    camera_check               boolean not null default false,
    microphone_check           boolean not null default false,
    fullscreen_check           boolean not null default false,
    face_check                 boolean not null default false,
    check_in_screenshot_at     timestamptz,
    system_check_completed_at  timestamptz,
    rules_accepted_at          timestamptz,
    created_at                 timestamptz not null default now(),
    updated_at                 timestamptz not null default now(),
    unique (candidate_id, exam_id)
);

alter table exam_preflight enable row level security;

-- ---------------------------------------------------------------------
-- exam_sessions.seconds_per_question — snapshot of the exam's
-- per-question timer taken when the session is created, so an admin
-- editing the exam's timer mid-exam can never shorten/lengthen a
-- student's already-running exam. NULL for sessions created before this
-- migration; the backend falls back to exams.seconds_per_question for
-- those.
-- ---------------------------------------------------------------------
alter table exam_sessions add column if not exists seconds_per_question integer;

-- At most one IN_PROGRESS session per candidate across ALL exams — the
-- database-level backstop for "a student's exam never switches when an
-- admin activates another exam". Only created when existing data already
-- satisfies it, so this migration can never fail on legacy rows.
do $$
begin
    if not exists (
        select candidate_id from exam_sessions
        where status = 'IN_PROGRESS'
        group by candidate_id having count(*) > 1
    ) then
        create unique index if not exists exam_sessions_one_in_progress_per_candidate
            on exam_sessions (candidate_id) where status = 'IN_PROGRESS';
    else
        raise notice 'Skipped exam_sessions_one_in_progress_per_candidate: some candidates already have more than one IN_PROGRESS session. Resolve those rows and re-run this file.';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- Result publication — results stay hidden from students until an admin
-- publishes them for that exam (PATCH /api/admin/exams/:id/results-
-- publication). Defaults to unpublished.
-- ---------------------------------------------------------------------
alter table exams add column if not exists results_published boolean not null default false;
alter table exams add column if not exists results_published_at timestamptz;

-- ---------------------------------------------------------------------
-- Check-in screenshots contain students' faces: force the bucket private
-- even if it was created (or later toggled) as public. 011 used
-- `on conflict do nothing`, which would have left an existing public
-- bucket public.
-- ---------------------------------------------------------------------
update storage.buckets
set public = false
where id = 'system-check-screenshots' and public = true;
