-- =====================================================================
-- 012 — exam_start_at / duration_minutes
--
-- Adds real admin-configurable exam scheduling: an exact start instant
-- (date + time, stored as a proper timestamptz — unlike 004_exam_date's
-- date-only column) and a total exam duration in minutes. Together these
-- define the exam's live window [exam_start_at, exam_start_at +
-- duration_minutes] that backend/src/controllers/_examShared.js's
-- computeTimingStatus() and the session/answer controllers enforce
-- server-side.
--
-- No backfill: existing exams are left with both columns NULL, which
-- every caller treats as "not scheduled" — i.e. exactly today's
-- behavior (no waiting room, no overall deadline, only the existing
-- per-question timer applies). Run once against the same EXAM_SUPABASE
-- project as 001-011. Idempotent.
-- =====================================================================

alter table exams
    add column if not exists exam_start_at timestamptz,
    add column if not exists duration_minutes integer;
