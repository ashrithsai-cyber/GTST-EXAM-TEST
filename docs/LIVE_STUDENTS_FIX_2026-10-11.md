# Live Students loading fix

Date: 11 October 2026 (Asia/Calcutta).

The configured exam Supabase project returned HTTP 404 / `PGRST202` for the read-only functions `admin_exam_attempt_progress` and `admin_monitoring_event_summary`. Both are defined in migration 021. A zero-row schema check confirmed its prerequisite `exam_events.is_violation` column exists. These checks changed no records.

The backend previously treated a missing progress function as a failure of the entire session list. The frontend also left its initial loading flag active after any failed request. Its API client had no timeout, so an unresponsive request could prevent subsequent polls indefinitely.

The session endpoint now returns student rows, status and saved warning counts when only the optional progress function is missing. The event-summary endpoint reports a specific migration error, which the monitoring service treats as a recoverable absence of detailed summaries. Genuine database outages still return errors. The page shows migration guidance, errors and Retry; unsuccessful polls keep the last good rows with an explicit stale-data warning. A 25-second timeout covers headers and response bodies for JSON and binary requests. Authentication and admin checks remain enforced. Violation totals use the database summary when available and the saved warning count otherwise; network telemetry is excluded from summary violation totals.

## Files changed for this fix

- `backend/src/controllers/admin.controller.js`
- `admin-frontend/src/services/apiClient.js`
- `admin-frontend/src/services/monitoring.js`
- `admin-frontend/src/newadmin/pages/LiveStudentsPage.tsx`
- `backend/test/sessions.test.js`
- `test/adminApiClient.test.js`
- `test/admin-live-browser.mjs`
- `package.json` (admin browser regression command)
- This report.

Other existing workspace changes belong to earlier work and are outside this fix.

## Verification

- 42 frontend/unit tests passed, including timeout, invalid API response and expired-session tests.
- 88 backend tests passed; 13 local PostgreSQL concurrency tests were skipped because no test database is configured.
- The existing student Chrome fixture suite passed.
- The new admin Chrome fixture verifies initial failure exits loading, Retry recovers, missing migration still shows students and saved warnings, a failed poll retains stale rows, and a healthy retry clears warnings and displays progress.
- Student and admin builds and admin type checking passed. Lint passed with existing warnings. Test APIs and databases were isolated fixtures; this is not a production verification or a 400-student load test.

## Next steps

Restart the backend and refresh the admin dashboard to use the local changes. Detailed monitoring progress and event summaries require pending migration `backend/sql/021_admin_monitoring_summary.sql`. Review and test it in staging against the existing schema before an approved production application. This fix does not require the reset/delete functions in migrations 022 or 023.

No migration was applied, no student records were modified or deleted, and nothing was deployed.
