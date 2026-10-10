-- =====================================================================
-- GTST+ Exam Admin Extensions
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001_exam_schema.sql / 002_admin_schema.sql. Idempotent —
-- safe to re-run. Purely additive: nothing here changes the meaning of
-- an existing column, and every new exam row is seeded INACTIVE, so the
-- student-facing getActiveExam() pick (backend/src/controllers/
-- _examShared.js) — which has always resolved to the single 'GTST-2026'
-- row from 001 — is unaffected. The live student exam does not change.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- exams.exam_type — lets the Admin Dashboard's "Final Exam Questions"
-- (exam_type = FINAL, one row per class the admin creates) and
-- "Mock Test" (exam_type = MOCK, the 4 fixed sections below) pages both
-- reuse the existing generic exam -> subjects -> questions CRUD without
-- a new table. Existing rows (GTST-2026) default to FINAL.
-- ---------------------------------------------------------------------
alter table exams
    add column if not exists exam_type text not null default 'FINAL'
        check (exam_type in ('FINAL', 'MOCK'));

-- The 4 fixed Mock Test sections the admin frontend expects to exist
-- from first load (rename-only, never created/deleted from the UI).
-- Seeded INACTIVE — never eligible to become "the" active student exam.
insert into exams (exam_code, exam_name, seconds_per_question, status, exam_type)
values
    ('MOCK-SECTION-1', 'Class Section 1', 60, 'INACTIVE', 'MOCK'),
    ('MOCK-SECTION-2', 'Class Section 2', 60, 'INACTIVE', 'MOCK'),
    ('MOCK-SECTION-3', 'Class Section 3', 60, 'INACTIVE', 'MOCK'),
    ('MOCK-SECTION-4', 'Class Section 4', 60, 'INACTIVE', 'MOCK')
on conflict (exam_code) do nothing;

-- ---------------------------------------------------------------------
-- exam_events.reviewed — backs the Violations page's "Mark as Reviewed"
-- action. Append-only table otherwise; this is the one field an admin
-- is allowed to set on an existing row.
-- ---------------------------------------------------------------------
alter table exam_events
    add column if not exists reviewed boolean not null default false;

alter table exam_events
    add column if not exists reviewed_at timestamptz;

alter table exam_events
    add column if not exists reviewed_by uuid references admin_users(id);

create index if not exists idx_exam_events_reviewed on exam_events(reviewed);

-- ---------------------------------------------------------------------
-- mock_videos — the demonstration video shown to students before the
-- exam. Modeled as a small history table but the admin API always
-- treats "the current video" as the single most-recent row; uploading
-- a new one deletes the previous row (and its storage object). The
-- actual bytes live in the 'mock-videos' Storage bucket below, this
-- table is metadata only.
-- ---------------------------------------------------------------------
create table if not exists mock_videos (
    id             uuid primary key default gen_random_uuid(),
    title          text not null,
    description    text,
    storage_path   text not null,
    file_name      text not null,
    file_size      bigint,
    mime_type      text,
    uploaded_by    uuid references admin_users(id),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

alter table mock_videos enable row level security;

-- Public-read bucket: the mock video is instructional content shown to
-- any student before the exam, not sensitive data, so serving it via a
-- public URL avoids needing the backend to mint signed URLs for every
-- playback. Only the backend's service_role client ever uploads/deletes
-- into it (via POST/DELETE /api/admin/mock-video) — the admin frontend
-- never receives a storage key, only the resulting public URL.
insert into storage.buckets (id, name, public, file_size_limit)
values ('mock-videos', 'mock-videos', true, 209715200)
on conflict (id) do nothing;
