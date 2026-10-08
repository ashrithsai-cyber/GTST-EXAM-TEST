# Exam database migrations

Run against the **dedicated exam Supabase project** (the one `EXAM_SUPABASE_URL`
points at), never the registration project. Paste each file into the Supabase
SQL Editor and run them **in numeric order, 001 through 019**. Each file
runs in its own transaction where it needs one.

| # | File | Purpose |
|---|---|---|
| 001 | `001_exam_schema.sql` | Core schema: candidates, exams, subjects, questions, attempts (`exam_sessions`), answers, events; sample exam seed |
| 002 | `002_admin_schema.sql` | Admin users and admin audit log |
| 003 | `003_admin_extensions.sql` | Admin extensions; `mock-videos` storage bucket (public) |
| 004 | `004_exam_date.sql` | Admin-configurable exam date |
| 005 | `005_settings_and_presence.sql` | Exam settings (camera/mic/fullscreen/face/proctoring toggles) and student presence |
| 006 | `006_question_status.sql` | Question ACTIVE/INACTIVE status |
| 007 | `007_proctoring_rules.sql` | Admin-managed proctoring rules |
| 008 | `008_single_admin_role.sql` | Single `admin` role |
| 009 | `009_exam_branding.sql` | Exam branding; `exam-branding` storage bucket (public) |
| 010 | `010_classes_hierarchy.sql` | Exam → Classes → Subjects → Questions; one ACTIVE exam at a time |
| 011 | `011_system_check_screenshots.sql` | Check-in photos; `system-check-screenshots` storage bucket (private) |
| 012 | `012_exam_timing.sql` | Scheduled start time and duration |
| 013 | `013_performance_indexes.sql` | Live-exam query indexes |
| 014 | `014_preflight_results_hardening.sql` | Server-side preflight, result publication, one running attempt per student, private screenshot bucket. **Required before students can start attempts.** |
| 015 | `015_photo_capture_setting.sql` | Independent check-in photo toggle |
| 016 | `016_exam_navigation.sql` | Per-question visited state (legacy navigation table) |
| 017 | `017_sequential_attempts.sql` | Fixed per-attempt question sequence, forward-only answers, server deadline, expiry |
| 018 | `018_single_device_sessions.sql` | One active device per student (10-minute idle grace) |
| 019 | `019_attempt_integrity.sql` | Final SUBMITTED/BLOCKED states, locked proctoring block, atomic attempt start, answer→sequence FK, admin device release |

**017, 018 and 019 are one deployment unit**: apply all three, then restart the
backend. The current backend refuses to create attempts without them.

## Re-running

002–019 are safe to re-run. 001 is **not** re-runnable once 010 has been
applied (its seed targets the pre-010 `subjects.exam_id` column); never re-run
it on an existing database.

## Notices to expect

019 may print `left NOT VALID` notices on databases holding attempts created
before 017. That is expected: the rule still applies to every new row. Run
the audit below to see the legacy rows it refers to.

## Checks (read-only)

`checks/attempt_consistency_audit.sql` — 15 consistency checks (duplicate
attempts, answers outside the sequence, submitted without completion time,
running past deadline, …). Every row should report `0`; `legacy_*` rows
describe pre-017 attempts. Safe to run at any time.

## Rollback

`rollback/019_attempt_integrity_down.sql` removes only 019's functions,
trigger and constraints; no rows are touched. It is rarely needed (the
previous backend runs with 019 applied). Run it only **after** rolling the
backend back. 001–018 are additive and are not rolled back.

## Verification

`backend/test/realMigrations.test.js` (part of `npm test`) applies these real
files 001–019 to a clean database on every run.
`npm run test:postgres` re-applies them to a local PostgreSQL server for the
multi-connection concurrency suite.
