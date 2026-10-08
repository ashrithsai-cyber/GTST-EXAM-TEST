-- =====================================================================
-- 013 — performance indexes
--
-- Indexes for the queries that run most often during a live exam:
--
--   * exam_sessions (exam_id, status)  — admin Dashboard / Live Students
--     poll every 10s filtering the active exam's sessions by status.
--   * exam_sessions (status, submitted_at) — admin Results list.
--   * exam_events (session_id, created_at) — the proctoring controller's
--     "was a warning already counted in the last few seconds" check on
--     every student event, and the per-session event drawer.
--   * exam_events (created_at) — Violations / Live Students polling,
--     newest first.
--   * system_check_screenshots (captured_at) — Captured Images gallery.
--   * questions (subject_id, question_number) is already covered by the
--     unique constraint from 001, so nothing is added for it here.
--
-- Additive only — no data or column changes. Run once against the same
-- EXAM_SUPABASE project as 001-012. Idempotent.
-- =====================================================================

create index if not exists idx_exam_sessions_exam_status
    on exam_sessions (exam_id, status);

create index if not exists idx_exam_sessions_status_submitted
    on exam_sessions (status, submitted_at desc);

create index if not exists idx_exam_events_session_created
    on exam_events (session_id, created_at desc);

create index if not exists idx_exam_events_created
    on exam_events (created_at desc);

create index if not exists idx_system_check_screenshots_captured
    on system_check_screenshots (captured_at desc);
