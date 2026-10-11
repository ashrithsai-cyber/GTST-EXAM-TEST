# Exam database migrations

Run against the **dedicated exam Supabase project** (the one `EXAM_SUPABASE_URL`
points at), never the registration project. Paste each file into the Supabase
SQL Editor and run them **in numeric order, 001 through 023**. Each file
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
| 020 | `020_reliable_proctoring.sql` | Idempotent proctoring-event capture, retry deduplication, and occurrence timestamps |
| 021 | `021_admin_monitoring_summary.sql` | Admin-only, session-scoped event summaries and saved-attempt progress summaries |
| 022 | `022_admin_reset_exam_attempts.sql` | Admin-only atomic reset of attempts for an inactive exam; clears attempt data and student login/preflight state |
| 023 | `023_admin_delete_exam_completely.sql` | Admin-only permanent deletion of an inactive exam and its exam-scoped data; returns private photo paths for backend storage cleanup |

**017–023 are one deployment unit for the current backend**: verify their
applied state, apply only pending migrations in order, then deploy/restart the
matching backend. Do not apply 020 before confirming that 019 is present, or
021 before confirming that 020 is present, or 022 before confirming that 018 is present,
or 023 before confirming that 011, 014, and 019 are present.

## Existing databases and migration safety

Never blindly replay historical migrations against a populated database.
First verify the database's applied migration state and take a verified
backup; then apply only missing migrations, in order. Migration 001 is not
re-runnable after 010, and 010 contains destructive legacy/sample-data cleanup
and schema changes. Idempotent DDL or a clean-database reapplication test does
not prove that replaying a migration is safe for existing records.

Migration 020 is additive and tested both from a clean schema and as an upgrade
over a disposable populated pre-020 fixture. Migrations 021–023 are additive.
Migration 022 adds a privileged reset function; it does not run or remove
records until an active admin explicitly confirms a reset in the dashboard.
Migration 023 adds a privileged permanent-delete function; it does not remove
records until an active admin types the exact exam name and confirms deletion.
It refuses active exams and exams with in-progress attempts. The backend also
removes private check-in photo objects after the database deletion; storage
cleanup failures are reported as partial completion and logged for support.
For an existing database, apply pending migrations only after confirming the prior
migration state and reviewing the target's schema, backup, and rollout plan.
Do not use this guide as permission to replay 001–019 or to apply migrations
without an approved rollout.

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
trigger and constraints; no rows are touched. It is rarely needed. Run it
only **after** rolling the backend back and verifying a staging rollback plan.
Do not infer that older migrations are safe to roll back: 010 changes existing
schema/data, and attempts may depend on 017/018/019 records.

## Verification

`backend/test/realMigrations.test.js` (part of `npm test`) applies these real
files 001–023 to a clean in-memory database and separately upgrades a disposable
fixture with representative legacy attempts, settings, preflight, and events
from 019 through 020/021. It also verifies exam reset and permanent deletion
against disposable database fixtures. This does not replace a schema/backup review for a
target database. Its reapplication check validates SQL behavior on a disposable
clean fixture only; it is not evidence of data-safe replaying all migrations.
`npm run test:postgres` re-applies them to a local PostgreSQL server for the
multi-connection concurrency suite.
