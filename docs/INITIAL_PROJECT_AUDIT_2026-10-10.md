# GTST+ initial project inspection

Date: 10 October 2026 (Asia/Calcutta).

This is the inspection report requested before implementation. No application code, migrations, database records, settings, credentials, or deployed services were changed. Local build output was regenerated for verification. This report is the only tracked file added.

## Scope and evidence

Inspected the student React portal, admin React/TypeScript dashboard, Express backend, migrations 001–019, database audit query, authentication, exam lifecycle, proctoring, monitoring, reporting, hosting configuration, and existing tests. Ran read-only checks against the configured registration and exam Supabase projects. No student login, write RPC, production test, or migration was executed against those projects.

The older `FINAL_AUDIT_REPORT.md` is useful history, but its test totals, git/archive observations, and claims about remaining issues should not be treated as a current certification.

## What already works

- Registration IDs and hall ticket numbers match case-insensitively, with whitespace trimming and wildcard rejection. Current backend tests confirm uppercase, lowercase, mixed-case, same-student matching, payment checks, and ambiguous-record rejection. No ID rewrite is needed.
- Exam questions and answer keys are snapshotted per attempt. Questions are delivered sequentially; answered questions lock. The current review feature summarizes answers, rather than reopening locked questions. Preserve that rule unless exam policy changes.
- Answers are saved on selection. Pending selections survive a same-tab refresh in session storage. Server-side draft restoration, offline recovery, timers, early submission, and final-question submission have automated coverage.
- Timer enforcement and scoring are server-side. Database functions use transactions and session row locks. Student/admin tokens are separate; student device leases and admin deactivation checks are present.
- The screenshot bucket is private. Branding and instruction-video buckets are public as intended.
- The admin dashboard and monitoring pages use real backend data. Existing monitoring/violation filters provide a foundation for improvements.

## Problems and proposed changes

Priority meanings: High = address before relying on the affected feature; Medium = correctness, reliability, or missing requested functionality; Operational = cannot certify solely through local code changes.

| ID | Priority | Finding | Proposed targeted change |
| --- | --- | --- | --- |
| 1 | High | Final submission can discard a pending selection after a failed draft save. `finalizeSubmission()` waits for the draft queue but ignores its error and submits without retrying `pendingDraft`. A student can see an answer selected even though the server retains an older selection. | Flush the latest pending answer before voluntary submission, display its save state, and keep submission retryable if persistence fails. Preserve server deadline rules. |
| 2 | High | Camera-loss reporting is incomplete. `useCamera` handles `ended`, but not sustained track mute, track disabling, or a stalled feed. Exam reporting relies on a ready-to-not-ready transition. | Add camera health monitoring with a grace period, recovery handling, an immediate warning, and regression coverage. Distinguish browser suspension from real device failure. |
| 3 | High | Failed proctoring events are dropped. `reportEventDetails()` returns null after a network/server failure, and camera/mic episode flags are reset without a durable retry. | Add an attempt-scoped event queue, event occurrence timestamps, retries, and server idempotency so reconnection does not silently lose or duplicate reports. |
| 4 | High | Fullscreen enforcement is confined to specific pages. Exam initialization starts/resumes the attempt before the fullscreen overlay is restored. The Summary page has no fullscreen/proctoring guard. Browser state is reported as client booleans, so the backend cannot independently prove physical fullscreen. | Centralize fullscreen capability checks and exam interaction guards; require a user gesture before a new attempt starts; cover refresh and review/summary consistently. Keep an existing attempt's server clock running during recovery. |
| 5 | High | Preflight start validation checks completion timestamps/rules/photo, but does not revalidate the saved camera/mic/fullscreen/face booleans against newly enabled settings. | Recheck required saved results at new-attempt start and return a clear system-check requirement when settings have become stricter. Do not invalidate already running attempts. |
| 6 | Medium | There is no screen-sharing acquisition, health monitoring, setting, or event type anywhere in the project. | Add explicit screen-capture permission and capability handling, supported-browser monitoring, and persisted stop/loss events. Define unavailable-browser behavior without silently weakening existing fullscreen/security requirements. |
| 7 | Medium | Camera preview placement is inconsistent. Phones up to 540 px have a fixed thumbnail, but tablets place the monitor after the question and subject panels. Rules/Summary contain no camera video element; `LiveCameraPreview` currently returns null. | Provide a shared preview positioned at the top across relevant pages and breakpoints, using one stream. Verify overlap, scrolling, orientation, and long questions. |
| 8 | Medium | Next without an answer still opens a confirmation modal. Existing browser tests explicitly enforce that behavior. | Replace it with a normal inline message; keep the existing explicit Skip action and automatic timeout advance. Update the behavioral test. |
| 9 | Medium | Video acceptance checks the container/extension, not playback codec compatibility. AVI, MOV, and assorted MP4 codecs can upload successfully and fail in a browser. Playback rejection handling is limited, and a failed/missing video bypasses the current video gate. | Improve playback controls, timeout/retry/error messages, codec guidance/validation, and any fallback policy. Do not silently treat a required, broken video as watched. Existing uploaded content should be preserved. |
| 10 | Medium | The dashboard only displays four statistic cards. Requested pie charts, bar charts, trends, and dashboard filters are absent. Its Logged In subtitle incorrectly describes a current pre-exam presence count as a verified-candidate total. Backend class breakdown also mixes all exams while headline counts refer to the active exam. | Add responsive, accessible charts and useful filters backed by correctly scoped database aggregates; clarify each metric and show loading, stale-data, error, and empty states. |
| 11 | Medium | No student/results/violation Excel or CSV reporting exists. The existing spreadsheet download is a question-import template. | Add authenticated report downloads with exam/class/status/date filters, full filtered datasets, and CSV formula-injection protection. |
| 12 | Medium | Results search filters only the current 50-row page, so a student on another page can appear missing. Fetch failures can look like an empty result; the Dashboard remains on its loading screen after an initial failure. | Apply search/filtering on the server before pagination and show explicit retryable errors. |
| 13 | High for capacity | Monitoring reloads all historical sessions, candidates, and events on every poll. Remaining event pages are fetched concurrently without a concurrency bound. This becomes increasingly expensive through an exam and across multiple admins. | Add bounded, filtered server summaries and paginated/incremental event history; avoid repeatedly downloading the full event log. |
| 14 | Medium | Monitoring progress uses the current question bank rather than the attempt snapshot and counts all listed questions, including inactive ones. This can disagree with students' frozen totals. `COPY_PASTE` is counted as a violation in the admin grouping although the backend treats it as informational. Network-drop counters count `NETWORK_DISCONNECT`, but the student currently reports only reconnects. | Derive progress from the attempt's authoritative position/total and unify event classifications and network-gap reporting. |
| 15 | Medium | Proctoring event insertion and warning-count updates are separate database operations. Three optimistic retries can be exhausted, or a count update can fail, while the API still returns success. Submission can race the initial status check. | Record an event and its counted status atomically, with ownership/final-status checks and a consistent aggregate count. Preserve the current capture-only policy; do not add automatic disqualification. |
| 16 | Medium | Admin fetches have no timeout; a hung fetch can leave polling permanently in flight. Student API timeout protection ends after response headers arrive, before JSON finishes loading. | Cover response-body reads, cancellation, polling recovery, and usable retry states. |
| 17 | High for data safety | Migration 010 deletes `MOCK-SECTION-%` exams, drops a column, and sets `class_id` NOT NULL without backfilling existing attempt rows. Migration 017 replaces the device validator with a fail-closed stub until 018 runs. The guide broadly calls 002–019 safe to rerun. Clean-database tests do not establish safe upgrades for every populated older database. | Audit applied state first, correct rollout instructions, add representative legacy-data migration tests, and prepare guarded/additive changes. Never bulk-rerun historical migrations on the existing database. |
| 18 | Medium | The live read-only consistency check found one submitted student's presence stage not marked COMPLETED. All other checked consistency totals were zero. | Find the update/race path and fix it; prepare a narrowly scoped reconciliation for the stale presence row without changing the attempt, answers, or result. No reconciliation was performed during inspection. |
| 19 | Medium/Operational | Dependency audit reports two moderate backend findings through ExcelJS/uuid and seven admin findings, including five high findings in the Tailwind build-tool chain. Root student dependencies have zero reported advisories. The older report records prior credential exposure; rotation cannot be established here. | Assess compatible dependency fixes and rerun import/build checks. Verify prior secret rotation with the owner. Do not run a forced breaking dependency downgrade or rotate live secrets during this inspection. |
| 20 | Operational | There is no 400-student staging load-test result. Real PostgreSQL concurrency tests are skipped without a local database. Physical devices, Safari/Firefox/Edge, embedded app browsers, backup/PITR, live function definitions/grants, and deployed hosting settings are not fully verified. | Build/run a staging capacity test with synchronized saves/timeouts, reconnects, login bursts, and multiple admins. Complete the browser/device matrix and backup/deployment checks before production approval. |

## Live database observations

These are inspection-time counts, not a backup or a load test:

| Dataset | Count |
| --- | ---: |
| Registrations | 350 |
| Exam candidates | 32 |
| Exams / classes / subjects | 2 / 5 / 17 |
| Questions | 160 |
| Exam attempts | 27, all SUBMITTED |
| Saved answers | 927 |
| Attempt question snapshots | 1,375 |
| Proctoring events | 203 |
| Check-in photos (metadata) | 26 |

One exam is ACTIVE. All 11 database function endpoints checked against the exact backend names are present in the service-role API metadata. This confirms availability, not that each live definition, index, trigger, RLS policy, or grant matches the migration source.

Using paginated read-only SELECTs, I computed equivalents of the 15 supplied consistency checks locally. Fourteen returned zero. `submitted_candidate_presence_not_completed` returned one. The SQL audit itself was not executed on the live server, and the reads were not a single database snapshot.

The current database enables camera, microphone, fullscreen, face detection, photo capture, instruction video, and proctoring. No settings were changed. Current tracked files and available git history do not show `.env` files; the archive named in the older audit is absent from the checked parent location. This does not verify whether previously exposed credentials were rotated.

## Baseline verification

| Check | Current result |
| --- | --- |
| Student unit tests | 32 passed, 0 failed |
| Backend tests, including actual migrations in PGlite | 69 passed, 0 failed; 13 local PostgreSQL concurrency tests skipped |
| Backend entry-point syntax check | Passed |
| Student and admin production builds | Passed locally; not deployed |
| Admin TypeScript check | Passed |
| Student/root lint | 0 errors; 4 warnings in test helpers |
| Admin lint | 0 errors; 10 React-effect warnings |
| Isolated Chrome browser suite | Passed; seven PASS scenario messages |
| Supabase inspection | Read-only connection/counts/schema-endpoint/bucket/consistency checks completed |

The first browser run timed out in sandboxed Chrome DevTools setup before any fixture requests. The isolated rerun outside that sandbox passed. Tests use generated/fake media and an in-memory API; they do not validate physical camera/microphone failure, real video playback, face recognition quality, or live database behavior end-to-end. The fixture currently asserts the popup behavior that you want changed.

## Proposed fix order

1. Protect pending answers and voluntary final submission; add failure/retry regression tests.
2. Centralize media/fullscreen guards, durable violation reporting, and supported screen-sharing monitoring; test refresh and recovery.
3. Fix preview placement, responsive layouts, inline unanswered feedback, playback recovery, and review/submission states.
4. Correct admin metrics/progress/search/errors; add charts, filters, and safe exports.
5. Reduce monitoring database traffic, make event counting atomic, assess dependency patches, and add safe migration/legacy-data coverage.
6. Run all checks again, then perform local concurrency and staging load/device tests where the required environment is available.

This sequence uses targeted changes within the existing architecture. Preserve registrations, hall tickets, question content, attempt snapshots, saved answers, scores, and audit records. Any eventual database rollout should use a verified backup and an explicit migration plan. No production deployment has been authorized or performed.

## Limits that code cannot remove

Fullscreen and screen capture require browser capability and user gestures/permissions. An ordinary website cannot prevent the operating system from switching applications, attest that all client JavaScript is unmodified, or provide missing embedded-browser APIs. Required checks should fail clearly with guidance to a supported browser, and optional checks should report capability honestly. See [MDN fullscreen requirements](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen) and [MDN screen-capture requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Approximately 400 students is a plausible engineering target, but it is not certified by passing the current unit/fixture tests or by today's 27 submitted attempts. Hosting, Supabase compute, shared-network bandwidth, and measured peak latency/error rates must be evaluated under representative staging traffic.
