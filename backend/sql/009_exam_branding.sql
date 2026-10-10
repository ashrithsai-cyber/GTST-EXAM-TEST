-- =====================================================================
-- GTST+ Exam Branding
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-008. Idempotent — safe to re-run. Purely additive.
--
-- exam_branding is a single global row (same "always read/update the
-- oldest row" pattern as exam_settings — see 005_settings_and_presence.sql
-- and settings.controller.js) backing the Admin "Exam Branding" page:
-- the exam name and logo shown across the ENTIRE Student Exam Portal
-- (header, footer, login page, exam-taking header), not a per-exam-row
-- field. Seeded with today's actual live values (the exact strings
-- previously hardcoded in the student frontend) so nothing changes
-- visually the moment this migration runs — only admin-editability is
-- added. The logo file itself lives in the 'exam-branding' Storage
-- bucket below; this table stores metadata only, same split as
-- mock_videos / the 'mock-videos' bucket in 003_admin_extensions.sql.
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists exam_branding (
    id                  uuid primary key default gen_random_uuid(),
    exam_name           text not null,
    logo_storage_path   text,
    logo_file_name      text,
    logo_mime_type      text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    updated_by          uuid references admin_users(id)
);

insert into exam_branding (exam_name)
select 'Global Talent Scholarship Test Plus · South India Level'
where not exists (select 1 from exam_branding);

alter table exam_branding enable row level security;

-- Public-read bucket: the exam logo is shown to every student (including
-- pre-login on the Landing page), not sensitive data, so a public URL
-- avoids needing the backend to mint signed URLs for every page load.
-- Only the backend's service_role client ever uploads/deletes into it
-- (via POST /api/admin/branding/logo) — the admin frontend never
-- receives a storage key, only the resulting public URL. 5MB is
-- generous for a logo image (vs. the 200MB video bucket).
insert into storage.buckets (id, name, public, file_size_limit)
values ('exam-branding', 'exam-branding', true, 5242880)
on conflict (id) do nothing;
