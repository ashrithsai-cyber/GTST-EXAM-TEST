# Database

Two Supabase projects. Only the backend connects to them, using service-role keys.

| Project | Used for | Access |
|---|---|---|
| Registration | `registrations` lookup at student login | Read-only, owned by the main website |
| Exam | Everything in this document | Read/write, schema from `backend/sql/` |

Migrations, order and re-run rules: [`backend/sql/README.md`](../backend/sql/README.md).
Every migration is verified on each `npm test` run by applying the real files
`001`–`019` to a clean PostgreSQL (PGlite).

## Data model (exam project)

```
exams ─┬─ classes ── subjects ── questions                    (question bank)
       │
exam_candidates ── exam_sessions (one attempt per candidate+exam)
                     ├── exam_attempt_questions  (frozen question sequence + answer key per attempt)
                     ├── exam_answers            (one row per answered question)
                     ├── exam_events             (proctoring events)
                     └── system_check_screenshots (check-in photo; bytes in private bucket)
exam_candidates ── student_login_sessions  (single-device lease)
                ── student_presence        (live stage for admin monitoring)
                ── exam_preflight          (server record of system check + rules acceptance)
exam_settings, exam_rules, exam_branding, mock_videos   (admin configuration)
admin_users ── admin_audit_logs
```

| Data | Where it is stored |
|---|---|
| Student identity | `exam_candidates` (`registration_id`, `hall_ticket_number`, `full_name`, `student_class`). Payment and documents stay in the registration project |
| Exam / attempt status, start, end, deadline, score | `exam_sessions` (`status`, `started_at`, `submitted_at`, `deadline_at`, `total_score`, `max_score`) |
| Questions, options, correct option, marks **as served** | `exam_attempt_questions` (snapshot taken when the attempt starts, so later bank edits never change a past result) |
| Selected option, correctness, time | `exam_answers` (`selected_option`, `is_attempted`, `is_correct`, `answered_at`) |
| Violations | `exam_events` (`event_type`, `event_message`, `created_at`, `reviewed`) and the running total `exam_sessions.proctoring_warning_count` |
| Check-in photo | `system_check_screenshots` + private bucket `system-check-screenshots` |

## Integrity guarantees

- **One attempt per student per exam:** `unique (candidate_id, exam_id)` on
  `exam_sessions`, plus at most one `IN_PROGRESS` attempt per student (partial unique index, `014`).
- **One answer per question:** `unique (session_id, question_id)` on `exam_answers`,
  and a foreign key to `exam_attempt_questions`, so an answer can only target a
  question in that attempt's sequence (`019`).
- **Atomic writes:** start, answer save, submit and expiry run as Postgres functions
  (`start_exam_attempt`, `save_exam_answer`, `submit_exam_attempt`,
  `expire_exam_attempts`). Each locks only that student's session row (`FOR UPDATE`),
  so students never wait on each other. Duplicate or concurrent submits are idempotent.
- **Final states are final:** trigger `exam_sessions_status_guard` prevents a
  `SUBMITTED`/`BLOCKED` attempt from returning to `IN_PROGRESS`.
- **Server-side deadline:** `deadline_at` is fixed when the attempt starts. The
  backend worker finalizes overdue attempts every 30 s (`SKIP LOCKED`, so it is safe
  with several backend instances).
- **History is protected:** an exam that students have taken cannot be deleted
  (`exam_sessions.exam_id` has no cascade). There is no API to delete candidates.
- **Single device:** `student_login_sessions` holds one lease per student, with
  10-minute idle expiry and admin release (audit-logged).

## Security

- **RLS is enabled on every table with no policies**, so the anon and authenticated
  roles can read or write nothing. Do not add policies.
- All 13 database functions are `SECURITY DEFINER` with a pinned `search_path`, and
  `EXECUTE` is revoked from `public`, `anon` and `authenticated` (granted to `service_role` only).
- Buckets: `mock-videos` and `exam-branding` are public (non-sensitive content).
  `system-check-screenshots` is **private**. Photos are streamed to admins through
  the backend only.

## Indexes relevant to the live exam

`exam_sessions(candidate_id)`, `(exam_id, status)`, `(status, submitted_at)`,
`deadline_at` (in-progress only) · `exam_answers(session_id)` + unique `(session_id, question_id)` ·
`exam_events(session_id)`, `(session_id, created_at)`, `(created_at)` ·
`exam_attempt_questions` primary key `(session_id, position)` ·
`student_login_sessions` primary key `candidate_id`, `(expires_at)` ·
`exams` unique partial index enforcing a single ACTIVE exam.

## Useful read-only queries

Run in the exam project's SQL Editor. These were checked against the migrated schema.

Per-question answer sheet for one student:

```sql
select c.registration_id, c.hall_ticket_number, c.full_name, e.exam_name,
       s.status, s.started_at, s.submitted_at, s.total_score, s.max_score,
       aq.position + 1 as sequence_number, aq.subject_name, aq.question_number, aq.question_text,
       a.selected_option, aq.correct_option, a.is_correct, a.answered_at
from exam_sessions s
join exam_candidates c on c.id = s.candidate_id
join exams e on e.id = s.exam_id
join exam_attempt_questions aq on aq.session_id = s.id
left join exam_answers a on a.session_id = s.id and a.question_id = aq.question_id
where c.registration_id = 'GTST26100094'          -- replace
order by aq.position;
```

All attempts for the active exam, with violation counts:

```sql
select c.registration_id, c.hall_ticket_number, c.full_name, e.exam_name, s.status,
       s.started_at, s.submitted_at, s.total_score, s.max_score,
       s.proctoring_warning_count as violation_count,
       (select count(*) from exam_answers a where a.session_id = s.id and a.is_attempted) as answered
from exam_sessions s
join exam_candidates c on c.id = s.candidate_id
join exams e on e.id = s.exam_id
where e.status = 'ACTIVE'
order by c.registration_id;
```

Violations per student and type:

```sql
select c.registration_id, c.full_name, ev.event_type, count(*) as occurrences,
       min(ev.created_at) as first_at, max(ev.created_at) as last_at
from exam_events ev
join exam_sessions s on s.id = ev.session_id
join exam_candidates c on c.id = s.candidate_id
group by c.registration_id, c.full_name, ev.event_type
order by c.registration_id, occurrences desc;
```

Consistency audit (15 checks, every row should be `0`):
`backend/sql/checks/attempt_consistency_audit.sql`.

## Known database considerations

- **Seed data:** `001` inserts exam `GTST-2026` with 60 placeholder questions.
  Replace it or make it inactive before the live exam.
- **PostgREST row cap:** Supabase returns at most *Max rows* (default 1000) per
  request. Admin lists paginate at 100 so they are unaffected. The admin Dashboard
  reads all `SUCCESS` registrations in one request, so if there are more than
  1000, raise *Max rows* or the "eligible / not started" counts will be capped.
- **Write volume:** at 400 students the backend makes roughly 250–300 database calls
  per second, with bursts when per-question timers expire together. See
  [`deployment.md` §6](deployment.md#6-capacity-for-400-concurrent-students).
- **Backups:** enable point-in-time recovery or take a snapshot before the exam.
