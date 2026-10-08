# API reference

Base URL: the backend origin, e.g. `https://api.your-domain.com`. Source of truth:
`backend/src/routes/*.routes.js` and the matching controllers.

## Conventions

- JSON bodies (≤ 100 KB) unless noted as `multipart/form-data`.
- Every response carries `success: true|false`. Errors look like
  `{ "success": false, "message": "…", "code"?: "…" }`. Error responses never
  include stack traces, SQL or configuration details.
- **Auth headers:** `Authorization: Bearer <token>`.
  - **Student** token: from `POST /api/exam/auth/login`. Each request also
    validates and renews the student's single-device lease.
  - **Admin** token: from `POST /api/admin/auth/login`. Each request re-checks
    that the admin is still active. The two token types are not interchangeable.
- All ids are UUIDs. A malformed id returns `404`/`400`, never `500`.
- Rate-limited requests return `429` with a JSON message.

### Common errors

| Status | Meaning |
|---|---|
| 400 | Invalid input / malformed JSON |
| 401 | Missing, invalid or expired token |
| 403 | Not allowed: other student's session, exam not in progress, preflight missing, CORS origin not allowed |
| 404 | Not found / unknown route |
| 409 | Conflict: `SESSION_ACTIVE` (another device), `SESSION_EXPIRED` (lease lost, log in again), stale/expired question, live-exam structure change |
| 413 | Upload too large |
| 429 | Rate limit |
| 500 | Server error (generic message) |
| 503 | Temporary database/session problem. The client should retry; saved answers are kept |

Attempt-related `code` values: `ACTIVE_SESSION_REQUIRED` (409), `NOT_FOUND` (404),
`FORBIDDEN` (403), `NOT_IN_PROGRESS` (403), `INVALID_OPTION` (400),
`STALE_QUESTION` (409), `QUESTION_EXPIRED` (409), `NO_QUESTIONS` (409),
`OTHER_ATTEMPT_IN_PROGRESS` (409), `INVALID_EXAM_CLASS` (409), `SEQUENCE_REQUIRED` (503).
Preflight: `SYSTEM_CHECK_INCOMPLETE` (400), `CHECK_IN_PHOTO_REQUIRED` (400),
`PREFLIGHT_REQUIRED` (403), `RULES_NOT_ACCEPTED` (403).

---

## Public

| Method | Endpoint | Purpose | Response |
|---|---|---|---|
| GET | `/` | Liveness text | `{ success, message }` |
| GET | `/api/health` | Health check for load balancers | `{ success, server: "online", serverTime }` |
| GET | `/api/exam/branding` | Exam name + logo for the login page (no auth) | `{ success, branding: { examName, logoUrl, updatedAt } \| null }` |

---

## Student authentication: `/api/exam/auth`

### POST `/api/exam/auth/login`
- **Auth:** none. If the previous token (even expired) is sent, it lets the
  same device resume its lease.
- **Rate limit:** 10 per 15 min per IP + registration id.
- **Request:** `{ "registrationId": "GTST26100094", "hallTicketNumber": "…" }`
- **Response 200:** `{ success, token, loginExpiresAt, student: { registrationId, hallTicketNumber, name, class, examName, examDate } }`
- **Errors:** 400 missing fields · 401 invalid credentials · 403 not eligible (payment not `SUCCESS`) · 409 `SESSION_ACTIVE` · 500/503

### POST `/api/exam/auth/heartbeat`
- **Auth:** student. Called every 30 s by the portal.
- **Response:** `{ success, serverTime, expiresAt, token? }`. A new `token` is returned when the current one is within 10 min of expiry.
- **Errors:** 401 · 409 `SESSION_EXPIRED` · 503

### POST `/api/exam/auth/logout`
- **Auth:** student token (an expired one is accepted). Releases this device's lease.
- **Response:** `{ success, message }`

---

## Pre-exam: `/api/exam`

All require the **student** token.

| Method | Endpoint | Purpose | Request | Response |
|---|---|---|---|---|
| GET | `/info` | Exam metadata for the dashboard (no question content) | — | `{ exam: { id, examName, examDate, secondsPerQuestion, totalQuestions, totalMarks, totalDurationSeconds }, subjects: [...] }` |
| GET | `/settings` | Admin requirement flags | — | `{ settings: { cameraRequired, photoCaptureEnabled, microphoneRequired, fullscreenRequired, proctoringEnabled, faceDetectionEnabled, videoRequired, networkMonitoringEnabled, tabSwitchMonitoringEnabled } }` |
| GET | `/rules` | Active proctoring rules | — | `{ rules: [{ id, text }] }` (empty → portal shows built-in defaults) |
| GET | `/mock-video` | Proctoring instruction video | — | `{ video: { id, title, description, url, fileName, fileSize, mimeType, createdAt, … } \| null }` |
| POST | `/presence` | Stage ping for admin monitoring (every 10 s) | `{ "stage": "SYSTEM_CHECK" \| "RULES" \| "IN_EXAM" }` | `{ success }` (always 200 for a valid stage) |
| POST | `/system-check/screenshot` | Check-in photo upload | `multipart/form-data`, field `screenshot` (JPEG/PNG, ≤ 5 MB, content-sniffed) | `{ success, applicable, captured?, replaced? }` (`applicable: false` when photo capture is off) · 400 invalid image · 413 |
| POST | `/preflight/system-check` | Record passed system check | `{ camera, microphone, fullscreen, face }` (booleans) | `{ success }` · 400 `SYSTEM_CHECK_INCOMPLETE` / `CHECK_IN_PHOTO_REQUIRED` |
| POST | `/preflight/rules-accepted` | Record rules acceptance | — | `{ success }` · 403 `PREFLIGHT_REQUIRED` |
| GET | `/result` | Own result (only after an admin publishes) | — | `{ submitted, published, completion, result? }`. `result` has scores and counts only, never the answer key |

Rate limits: `/system-check/screenshot` 15 per 10 min · `/preflight/*` 30 per 10 min ·
other reads 120/min (per student).

---

## Exam session: `/api/exam`

All require the **student** token.

### POST `/api/exam/session/start`
Starts or resumes the student's attempt. Safe to call repeatedly: it never resets progress.
- **Rate limit:** 40/min.
- **Response 200 (waiting room):** `{ success, waiting: true, serverTime, examStartAt, secondsUntilStart }`
- **Response 200 (started/resumed):** `{ success, session: { id, status, currentPosition, totalQuestions, startedAt, deadlineAt, remainingSeconds, … }, exam: { id, examName, secondsPerQuestion, totalQuestions }, …timing }`
- **Errors:** 403 `PREFLIGHT_REQUIRED` / `RULES_NOT_ACCEPTED` · 403 already submitted / window ended (`status: "SUBMITTED"`) · 404 no active exam / no content for the class · 409 attempt codes · 503

### GET `/api/exam/current-question`
The single current question. Unreached questions and `correct_option` are never sent.
- **Response:** `{ success, examComplete, sessionId, exam, subjectIndex, questionIndex, totalQuestions, sequenceNumber, subject, question: { id, questionText, passage, options: { A, B, C, D }, marks, … }, selectedOption, remainingSeconds, … }`
- **Errors:** 403 submitted · 404 no session · 503

### POST `/api/exam/answers/draft`
Saves the current selection without advancing (called on every selection).
- **Rate limit:** 60/min (shared with `/answers`).
- **Request:** `{ "sessionId": "<uuid>", "questionId": "<uuid>", "selectedOption": "A" | "B" | "C" | "D" | null }`
- **Response:** `{ success, selectedOption, serverTime, draftSaved: true }`
- **Errors:** 400 · 409 `STALE_QUESTION` / `QUESTION_EXPIRED` / `ACTIVE_SESSION_REQUIRED` · 503

### POST `/api/exam/answers`
Locks the answer for the current question and advances (Next, or the timer reaching zero).
- **Request:** same as draft (`selectedOption` may be `null` for an unanswered timeout).
- **Response:** `{ success, message, timedOut, autoSubmitted, status, sectionComplete, examComplete, sequenceNumber, totalQuestions, nextQuestion, remainingSeconds, … }`
- **Errors:** as for draft

### GET `/api/exam/answers/:sessionId`
The student's saved selections (no correctness).
- **Response:** `{ answers: [{ questionId, subjectKey, questionNumber, sequenceNumber, selectedOption, isAttempted }] }` · 403 not own session · 404

### GET `/api/exam/navigation?sessionId=<uuid>`
Progress metadata for the review/summary screen (positions, answered, locked).

### POST `/api/exam/navigation/question`, PATCH `/navigation/state`, PATCH `/navigation/answer`
Legacy free-navigation endpoints. They **always return `403 SEQUENTIAL_EXAM`**: the
exam is forward-only. They are kept so an old cached client cannot edit earlier answers.

### POST `/api/exam/session/submit`
- **Request:** `{ "sessionId": "<uuid>" }`
- **Response:** `{ success, message, status: "SUBMITTED", submittedAt, attemptedCount, totalQuestions }`. The score is not returned.
- **Errors:** 400 · 403 · 409 · 503 ("Your saved answers are retained; please reconnect and retry")

### POST `/api/exam/proctoring/event`
- **Rate limit:** 30/min per student.
- **Request:** `{ "sessionId": "<uuid>", "eventType": "<type>", "eventMessage"?: "≤ 500 chars" }`
  - `eventType`: `MULTIPLE_FACE`, `NO_FACE`, `CAMERA_DISABLED`, `MICROPHONE_DISABLED`,
    `TAB_SWITCH`, `WINDOW_BLUR`, `FULLSCREEN_EXIT`, `RIGHT_CLICK`, `COPY_PASTE`,
    `NETWORK_DISCONNECT`, `NETWORK_RECONNECT`, `EXAM_LEFT`
- **Response:** `{ success, recorded, violation, violationCount, blocked: false, eventId }`.
  `recorded: false` if that category is disabled in Exam Settings. Never blocks the attempt.
- **Errors:** 400 invalid type · 403 other student's / submitted session · 404

---

## Admin authentication: `/api/admin/auth`

| Method | Endpoint | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| POST | `/login` | none (10 per 15 min per IP) | `{ email, password }` | `{ success, token, admin: { id, name, email, role } }` | 400 · 401 invalid credentials · 403 inactive |
| GET | `/me` | admin | — | `{ success, admin }` | 401 |

---

## Admin API: `/api/admin` (all require the admin token)

Lists accept `?page=` and `?limit=` (max 100) and return `{ page, limit, total, <items> }`.

| Method | Endpoint | Purpose / key request fields |
|---|---|---|
| GET | `/dashboard` | Counts: eligible, logged in, in progress, submitted, disconnected, class breakdown, average score |
| GET | `/candidates` | Students (`?search=`) with active-exam session and presence |
| GET | `/candidates/:candidateId` | One student |
| GET | `/candidates/:candidateId/device-session` | Current device lease |
| POST | `/candidates/:candidateId/device-session/release` | Release a stuck device. `{ reason }` required (≤ 500 chars, audit-logged) |
| GET / POST | `/exams` | List / create. `{ examCode, examName, secondsPerQuestion, status?, examDate?, examStartAt?, durationMinutes? }` |
| GET / PUT / DELETE | `/exams/:examId` | Read / update `{ examName, secondsPerQuestion, examDate, examStartAt, durationMinutes }` / delete (409 if active or already taken) |
| PATCH | `/exams/:examId/status` | `{ status: "ACTIVE" \| "INACTIVE" }` (only one ACTIVE exam) |
| PATCH | `/exams/:examId/results-publication` | `{ published: boolean }` |
| GET / POST | `/exams/:examId/classes` | List / create `{ className, displayOrder? }` |
| PUT / DELETE | `/classes/:classId` | Update / delete (409 while students are writing) |
| GET / POST | `/classes/:classId/subjects` | List / create `{ subjectKey, subjectName, displayOrder? }` |
| PUT / DELETE | `/subjects/:subjectId` | Update `{ subjectName, displayOrder }` / delete |
| GET | `/question-template` | Download the Excel import template |
| GET / POST | `/subjects/:subjectId/questions` | List / create `{ questionNumber, questionText, passage?, optionA–D, correctOption, marks, status? }` |
| POST | `/subjects/:subjectId/questions/import` | `multipart/form-data`, field `file` (.xlsx) |
| GET / PUT / DELETE | `/questions/:questionId` | Read / update / delete (add/delete blocked while students are writing; text edits allowed) |
| GET | `/sessions` | Attempts (`?status=IN_PROGRESS,SUBMITTED,…`, `?examId=`) with presence and disconnection flag |
| GET | `/sessions/:sessionId` | One attempt |
| GET | `/sessions/:sessionId/result` | Score summary |
| GET | `/sessions/:sessionId/answer-sheet` | Every question with options, selected option, correct option, correctness, marks |
| GET | `/results` | Submitted attempts with scores |
| GET | `/proctoring/events` | Events (`?sessionId=`, `?eventType=`, `?reviewed=`) with student/exam |
| PATCH | `/proctoring/events/:eventId/review` | Mark an event reviewed |
| GET | `/audit-logs` | Admin action log (`?action=`, `?resourceType=`) |
| GET | `/system-check-screenshots` | Check-in photos (`?search=`, `?candidateId=`, `?examId=`) |
| GET | `/system-check-screenshots/:id/image` | Photo bytes, streamed from the private bucket |
| GET / POST / DELETE | `/mock-video` | Instruction video. Upload: `multipart/form-data`, field `video` (≤ 200 MB), `title`, `description` |
| PUT | `/mock-video/details` | `{ title, description }` |
| GET / PUT | `/branding` | `{ examName }` |
| POST | `/branding/logo` | `multipart/form-data`, field `logo` (image) |
| GET / PUT | `/settings` | Boolean flags (see `/api/exam/settings`) |
| GET / POST | `/rules` | Proctoring rules. Create `{ ruleText }` |
| PUT / DELETE | `/rules/:ruleId` | `{ ruleText?, displayOrder?, isActive? }` |
| GET / POST | `/users` | Admin accounts. Create `{ name, email, password }` (≥ 10 chars) |
| PUT | `/users/:adminId` | `{ name?, password? }` |
| PATCH | `/users/:adminId/status` | `{ isActive: boolean }` |

Uploads (video, logo, question import) share a limit of 30 per hour per admin.
