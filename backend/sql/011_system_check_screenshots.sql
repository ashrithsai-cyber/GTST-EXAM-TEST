-- =====================================================================
-- GTST+ System Check Screenshots
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-010. Idempotent — safe to re-run.
--
-- Backs the automatic, no-click screenshot captured the moment a student
-- passes all required System Check requirements (camera/mic/fullscreen/
-- face detection, whichever the admin has enabled) — see
-- backend/src/controllers/screenshot.controller.js and
-- src/pages/SystemCheckPage.jsx.
--
-- exam_sessions does not exist yet at System Check time (startSession
-- only runs once the student actually enters the exam, well after
-- System Check -> Proctoring Rules), so this is keyed by
-- (candidate_id, exam_id) instead — the same pair
-- getActiveExamForStudent() already resolves for class-based delivery
-- (see _examShared.js) — and session_id is backfilled once startSession
-- creates the real session. The unique constraint below is what makes
-- "once per exam" and "no duplicates on refresh" hold even under a
-- race (concurrent requests, double-mounted effects, multiple tabs).
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists system_check_screenshots (
    id                  uuid primary key default gen_random_uuid(),
    candidate_id        uuid not null references exam_candidates(id) on delete cascade,
    exam_id             uuid not null references exams(id),
    session_id          uuid references exam_sessions(id),
    registration_id     text not null,
    hall_ticket_number  text,
    storage_path        text not null,
    captured_at         timestamptz not null default now(),
    created_at          timestamptz not null default now(),
    unique (candidate_id, exam_id)
);

alter table system_check_screenshots enable row level security;

-- Private bucket — unlike the branding logo / mock video buckets, this
-- contains the student's own camera feed and identifying context, not
-- shareable public content. Only the backend's service_role client ever
-- reads/writes it; no public URL is ever generated for it. 5MB is
-- generous for a single-page JPEG snapshot, just bounding abuse.
insert into storage.buckets (id, name, public, file_size_limit)
values ('system-check-screenshots', 'system-check-screenshots', false, 5242880)
on conflict (id) do nothing;
