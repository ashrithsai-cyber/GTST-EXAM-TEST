-- =====================================================================
-- GTST+ Exam Settings + Student Presence
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-004. Idempotent — safe to re-run. Purely additive.
--
-- exam_settings backs the new Admin "Exam Settings" page — real,
-- backend-enforced toggles (camera/mic/fullscreen/proctoring/face
-- detection/video/network monitoring/tab-switch monitoring), not a
-- frontend-only appearance change. Every column defaults to `true`,
-- matching today's hardcoded student-frontend behavior exactly, so an
-- unmigrated environment (or one where this table is empty) behaves
-- identically to before this migration ran.
--
-- student_presence backs the Admin "Live Students" page's granular
-- pre-exam status (Logged In / System Check / Watching Rules / In Exam /
-- Completed) — a small, separate table rather than a change to the
-- security-sensitive exam_sessions state machine.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- exam_candidates.hall_ticket_number — verified at login against the
-- Registration Supabase (see backend/src/controllers/auth.controller.js)
-- but never persisted locally until now. Nullable: existing rows created
-- before this migration simply show "Not available" until the student
-- next logs in and the value is backfilled by the upsert.
-- ---------------------------------------------------------------------
alter table exam_candidates add column if not exists hall_ticket_number text;

-- ---------------------------------------------------------------------
-- exam_settings — a single global settings row. The application always
-- reads/updates the oldest row (order by created_at limit 1) rather than
-- relying on a hardcoded id, so this works the first time it's queried
-- even if the seed insert below is skipped for any reason.
-- ---------------------------------------------------------------------
create table if not exists exam_settings (
    id                              uuid primary key default gen_random_uuid(),
    camera_required                 boolean not null default true,
    photo_capture_enabled          boolean not null default true,
    microphone_required             boolean not null default true,
    fullscreen_required              boolean not null default true,
    proctoring_enabled              boolean not null default true,
    face_detection_enabled          boolean not null default true,
    video_required                  boolean not null default true,
    network_monitoring_enabled      boolean not null default true,
    tab_switch_monitoring_enabled   boolean not null default true,
    created_at                      timestamptz not null default now(),
    updated_at                      timestamptz not null default now(),
    updated_by                      uuid references admin_users(id)
);

insert into exam_settings (id)
select gen_random_uuid()
where not exists (select 1 from exam_settings);

-- ---------------------------------------------------------------------
-- student_presence — one row per candidate, upserted as they move
-- through login -> system check -> rules -> exam -> submitted. Never
-- read by anything security-sensitive (scoring, question delivery,
-- session blocking) — display-only, for the admin Live Students page.
-- ---------------------------------------------------------------------
create table if not exists student_presence (
    candidate_id  uuid primary key references exam_candidates(id) on delete cascade,
    stage         text not null check (stage in ('LOGGED_IN', 'SYSTEM_CHECK', 'RULES', 'IN_EXAM', 'COMPLETED')),
    updated_at    timestamptz not null default now()
);

alter table exam_settings enable row level security;
alter table student_presence enable row level security;
