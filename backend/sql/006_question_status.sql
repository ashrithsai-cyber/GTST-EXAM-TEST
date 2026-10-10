-- =====================================================================
-- GTST+ Question Status
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-005. Idempotent — safe to re-run. Purely additive.
--
-- Admin-side organizational field only (Active/Inactive, for filtering
-- and curation on the Questions page) — deliberately NOT consulted by
-- the student-facing delivery pipeline (backend/src/controllers/
-- _examShared.js's pointer-based question resolution, which assumes a
-- dense 1..N question_number sequence per subject). Making "Inactive"
-- actually skip a question during a live exam would require reworking
-- that pointer resolution — a change to the most security-sensitive
-- part of this system, intentionally not bundled into this migration.
-- =====================================================================

alter table questions
    add column if not exists status text not null default 'ACTIVE'
        check (status in ('ACTIVE', 'INACTIVE'));
