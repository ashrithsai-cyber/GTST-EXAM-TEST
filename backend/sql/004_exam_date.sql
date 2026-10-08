-- =====================================================================
-- 004 — exam_date
--
-- Adds a real, admin-configurable scheduled date for an exam. Before
-- this, "exam date" had no database column at all — the student
-- dashboard/login response fell back to a static EXAM_DATE env var that
-- an admin could not change without a backend restart. Run once against
-- the same EXAM_SUPABASE project as 001-003. Idempotent.
-- =====================================================================

alter table exams
    add column if not exists exam_date date;

-- No backfill/default: existing exams are left NULL ("not scheduled"),
-- which the API and admin UI already treat as a legitimate, honestly
-- unset state rather than fabricating a date that was never configured.
