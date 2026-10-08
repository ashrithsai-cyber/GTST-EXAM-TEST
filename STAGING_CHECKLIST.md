# GTST Exam Portal — Staging Deployment Checklist

Staging only. **Do not deploy to production from this checklist.**
Each section ends with what "pass" looks like. Record failures before
moving on; a failed item in sections 1–6 blocks the verification runs in 7.

---

## 0. Before you start

- [ ] Staging uses its **own** Supabase projects (exam + registration copy), never production's.
- [ ] Note the git commit / archive being deployed.
- [ ] Keep the **previous** backend build and both previous frontend `dist/` folders, so you can roll back (section 8).
- [ ] Take a database snapshot of the staging exam project (Supabase backup / PITR, or `pg_dump`).
- [ ] Local gate on the deployed commit:
  - `cd backend && npm ci && npm test && npm run check`. Expect 58 pass, 0 fail; the 13 PostgreSQL cases skip unless `TEST_DATABASE_URL` is set.
  - `npm ci && npm test && npm run build && npm run test:browser` (root). Expect 13 unit tests and 6 `PASS:` browser scenarios.
  - `cd admin-frontend && npm ci && npm run typecheck && npm run build`
  - Optional: `TEST_DATABASE_URL=postgres://…@127.0.0.1:…/postgres npm run test:postgres` against a **local** PostgreSQL. Expect 13/13.

## 1. Database migration (exam Supabase project)

Full order and purposes: [`backend/sql/README.md`](backend/sql/README.md).

- [ ] If the staging database already has data, run the read-only `backend/sql/checks/attempt_consistency_audit.sql` and save the output ("before").
- [ ] In the SQL Editor, run each pending file **in numeric order**, `001` → `019`. Fresh database: all 19. Existing database: only the ones not yet applied.
- [ ] `017`, `018` and `019` are applied together, then the backend is (re)started.
- [ ] Never re-run `001` on an existing database (it breaks after `010`). 002–019 are safe to re-run.
- [ ] `019` notices saying `left NOT VALID` are expected only if the database holds pre-017 attempts.
- [ ] Verify objects exist:
  ```sql
  select proname from pg_proc where proname in
    ('init_exam_attempt','save_exam_answer','submit_exam_attempt','expire_exam_attempts',
     'acquire_student_login_session','touch_student_login_session','assert_exam_login_session',
     'start_exam_attempt','block_exam_attempt','admin_release_student_login_session') order by 1;
  -- expect 10 rows
  select tgname from pg_trigger where tgname = 'exam_sessions_status_guard';  -- expect 1 row
  ```
- [ ] Run the audit again ("after"): every check `0`. `legacy_*` rows may be non-zero only for pre-017 data.

**Pass:** 10 functions, 1 trigger, audit all zero.

## 2. Supabase configuration

- [ ] **Two projects:** registration (read-only lookup of `registrations`) and exam (all migrations). The backend uses service-role keys for both; the frontends never talk to Supabase directly.
- [ ] Storage buckets in the exam project, created by migrations. Confirm in Storage settings:
  - `mock-videos`: public
  - `exam-branding`: public
  - `system-check-screenshots`: **private** (`public = false`)
- [ ] RLS is enabled on every exam table (migrations enable it). Do **not** add policies for `anon`/`authenticated`. No anon key is needed anywhere.
- [ ] Registration project has staging test rows in `registrations` with `payment_status = 'SUCCESS'`, `registration_id`, `hall_ticket_number`, `student_class` (e.g. `10`).
- [ ] Create the first admin, from `backend/`: `node src/scripts/createSuperAdmin.js` (interactive prompts).
- [ ] In the admin dashboard:
  - exactly **one** exam ACTIVE
  - a class whose number matches the students' `student_class` (e.g. "Class 10")
  - subjects and questions
  - seconds per question; optional start time and duration
- [ ] Exam Settings: enable **camera, check-in photo, microphone, fullscreen, face detection, proctoring, tab-switch monitoring** for the staging run.
- [ ] Upload the proctoring instruction video, review Proctoring Rules and Branding.

**Pass:** buckets correct, admin can log in, one active exam with questions for the test class.

## 3. Environment variables

Templates: `backend/.env.example`, `.env.example`, `admin-frontend/.env.example`.

### Backend (secret store of the backend host)

| Variable | Staging value / rule |
|---|---|
| `NODE_ENV` | `production` (disables the dev localhost CORS allowance) |
| `PORT` | Host's port (default `5000`) |
| `TRUST_PROXY` | Number of proxies in front (usually `1` behind a platform proxy/LB). Needed so rate limits see real client IPs |
| `REGISTRATION_SUPABASE_URL` / `REGISTRATION_SUPABASE_SERVICE_ROLE_KEY` | Staging registration project |
| `EXAM_SUPABASE_URL` / `EXAM_SUPABASE_SERVICE_ROLE_KEY` | Staging exam project |
| `STUDENT_JWT_SECRET` | ≥ 32 chars, random. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_JWT_SECRET` | ≥ 32 chars, random, **different** from the student secret |
| `STUDENT_JWT_EXPIRES_IN` | `4h` (tokens are renewed by the heartbeat while active) |
| `ADMIN_JWT_EXPIRES_IN` | `8h` |
| `STUDENT_ALLOWED_ORIGINS` | Exact HTTPS origin of the staging student site, e.g. `https://exam-staging.example.com` |
| `ADMIN_ALLOWED_ORIGINS` | Exact HTTPS origin of the staging admin site. Never `*` |
| `EXAM_DATE` | Optional. Shown only if the active exam has no date |
| `PREFLIGHT_MAX_AGE_MINUTES` | Optional. Default `720` |

The server **refuses to start** if a JWT secret is missing, shorter than 32 characters, or identical to the other.

### Frontends (build time only)

| Variable | Rule |
|---|---|
| `VITE_API_URL` (student `.env`) | Staging backend HTTPS base URL, e.g. `https://api-staging.example.com` |
| `VITE_API_URL` (admin `.env`) | Same backend URL |

`VITE_API_URL` is **baked in at build time**. The `dist/` folders currently in the repo were built **without** it: they call `/api` on their own origin. Rebuild both with the staging URL (sections 5–6) unless a reverse proxy serves the backend under the same domain. Never put secrets in `VITE_*`.

## 4. Backend deployment

- [ ] Node.js **20 or newer**.
- [ ] `cd backend && npm ci --omit=dev && npm start`.
- [ ] HTTPS in front of it; set `TRUST_PROXY` accordingly.
- [ ] `GET https://<backend>/api/health` → `{"success":true,"server":"online",…}`.
- [ ] Logs show no `[attemptExpiry]` or `[student session]` errors. Those mean migrations 017/018/019 are missing.
- [ ] Multiple instances are safe: each runs the 30-second deadline worker, and the database serializes it (`SKIP LOCKED`).

**Pass:** health OK, no startup or worker errors, CORS allows only the two staging origins.

## 5. Student frontend deployment

- [ ] Set `VITE_API_URL` in root `.env`, then `npm ci && npm run build` (the prebuild step copies the MediaPipe WASM into `public/mediapipe/wasm`).
- [ ] Deploy `dist/` over **HTTPS** (camera and microphone are blocked on insecure origins).
- [ ] SPA rewrite: unknown paths → `index.html` (`/exam`, `/system-check`, …).
- [ ] Serve `.wasm` as `application/wasm`. Don't long-cache `index.html`; hashed `assets/` may be cached.
- [ ] **Face model file:** confirm `dist/mediapipe/blaze_face_short_range.tflite` (≈224 KB) and `dist/mediapipe/wasm/` exist after the build, so face detection is served from your own origin. The public CDN is used only if they are missing.

## 6. Admin frontend deployment

- [ ] Set `VITE_API_URL` in `admin-frontend/.env`, then `cd admin-frontend && npm ci && npm run build`.
- [ ] Deploy `admin-frontend/dist/` over HTTPS with the SPA rewrite to `index.html`.
- [ ] Its origin is exactly `ADMIN_ALLOWED_ORIGINS`.
- [ ] Log in, open Dashboard, Exams, Live Students, Student Data, Violations, Captured Images, Audit Logs. No errors.

## 7. Staging verification (real devices)

Use at least: one Windows/Chrome laptop with webcam and mic, one second device (phone or laptop), and one admin browser. Use a short test exam (e.g. 5 questions, 30–60 s each).

### 7.1 Camera permissions
- [ ] First visit to System Check prompts for the camera. **Deny** → clear failure message, cannot continue.
- [ ] Re-allow via site settings → **Retry** → live preview, camera check passes.
- [ ] "I Agree" → 3-second countdown → check-in photo taken and uploaded → appears in admin **Captured Images**.
- [ ] Cover or unplug the camera mid-exam → banner, and a `CAMERA_DISABLED` event in admin Violations.

### 7.2 Microphone permissions
- [ ] **Deny** permission → failure shown, cannot continue.
- [ ] **No microphone** (disabled or unplugged) → "no microphone" failure, cannot continue.
- [ ] Permission granted but **silent** → meter stays at 0, "No sound detected", cannot continue.
- [ ] Speak normally → meter moves, "Your microphone test passed."
- [ ] Mute or unplug mid-exam → `MICROPHONE_DISABLED` event recorded. Ordinary silence is not reported.

### 7.3 Fullscreen
- [ ] System Check requires "Enter Fullscreen" before continuing.
- [ ] Press **Esc** during the exam → blocking "Full-Screen Mode Required" overlay, plus a `FULLSCREEN_EXIT` warning. "Return to Full Screen" restores it.
- [ ] **Refresh during the exam** → "Leave site?" prompt; after reload, same question, plus the overlay with "Return to Full Screen". *(Automated tests could not check this: headless Chrome keeps fullscreen across a reload.)*
- [ ] On a browser without fullscreen support (e.g. iPhone Safari) → "not supported" message, cannot start.

### 7.4 Face recognition *(manual only, never automated)*
- [ ] The face model loads (no model error on System Check). If it fails, check section 5's model file or CDN access.
- [ ] One face in good light → passes.
- [ ] No face → failure on System Check; during the exam, `NO_FACE` after the ~3-second grace.
- [ ] Two faces → `MULTIPLE_FACE` event.
- [ ] Repeat once in poor or back-lit conditions, and note false positives.

### 7.5 Proctoring
- [ ] Switch tabs once → a popup explains the activity was recorded (no "N/3" counter); one event in Violations. Tab switch + blur + fullscreen exit from **one** action are coalesced.
- [ ] Trigger many violations → the exam **continues**; violations are captured for review only and never block the attempt. The admin violation count rises.
- [ ] Submit an exam, then trigger a tab switch → the attempt stays **Completed**.
- [ ] Right-click and copy/paste are blocked. Right-click counts as a violation; copy/paste is logged only.
- [ ] Turn a category off in Exam Settings → that event is no longer recorded.

### 7.6 Device session
- [ ] Device A logged in → Device B logs in with the same credentials → "Your exam is already active on another device."
- [ ] Device A refresh → continues the same attempt, no new login.
- [ ] Device A Wi-Fi off for ~1 minute → back online → continues; unsent answer saved ("Answer saved").
- [ ] Close Device A without logging out; after **10+ minutes** Device B can log in and continues the **same** attempt and question.
- [ ] Admin: Student Data → student → **Device Session** → shows signed-in and last-seen times. Release with a reason → Device A gets "session expired"; Device B logs in; **Audit Logs** shows `RELEASE_DEVICE_SESSION` with the reason.
- [ ] Logout on A → B can log in immediately.

### 7.7 Exam timer
- [ ] Exam and question timers count down; **refresh does not reset** either.
- [ ] Change the computer's clock ±1 hour mid-exam (without refreshing) → remaining time unchanged. *(A refresh with the clock pushed forward makes the saved login look expired: the student logs in again and resumes the same attempt.)*
- [ ] Let a question run out → advances automatically; the last selected answer is kept.
- [ ] Wi-Fi off past a question's time → reconnect → advances **automatically** (no click needed).
- [ ] Let the whole exam time run out → answers auto-saved, completion page shown.
- [ ] Close the browser before the deadline → admin shows **Completed** within ~30 s after the deadline.
- [ ] Scheduled exam: before the start time students see the waiting room; the exam opens at the server-clock start.
- [ ] Change the exam's start or duration while an attempt is running → **that** attempt keeps its deadline (intended policy).
- [ ] After completion, logging in again shows "Your examination has been completed"; no restart is possible.

### 7.8 Admin monitoring
- [ ] Dashboard counts move correctly: Logged In → In Progress → Submitted (and Blocked).
- [ ] Live Students shows stage (System Check / Rules / In Exam), warnings and **Disconnected** after ~90 s without contact (or 2× the seconds per question, if longer).
- [ ] A completed student who logs in again still shows **Completed**, not "Logged In".
- [ ] Results stay hidden from students until published; scores visible to the admin.
- [ ] Admin actions (exam edits, device release) appear in Audit Logs.

### 7.9 Data integrity after the runs
- [ ] Run `backend/sql/checks/attempt_consistency_audit.sql` → every non-legacy check `0`.

## 8. Rollback procedure

Database migrations 001–019 are **additive**. Roll back the application first; touch the database only if needed.

1. **Decide:** roll back for blocked logins, attempts that cannot start or save, wrong scoring, or backend errors that a config fix cannot resolve. Avoid rolling back while attempts are running; if you must, announce a pause first.
2. **Capture state:** save backend logs and run the audit query.
3. **Application:** redeploy the previous backend build and the previous student and admin `dist/` folders (kept in section 0). Check `/api/health`.
4. **Database: leave 001–019 in place.** By code inspection, the previous backend version runs with 019 applied. This has not been tested, so verify step 6 on staging. Do **not** roll back across 017/018 while attempts exist: their question sequences live in those tables.
5. **Only if 019 itself is the problem**, and only **after** step 3: run `backend/sql/rollback/019_attempt_integrity_down.sql`. It removes 019's functions, trigger and constraints and touches no rows. The current backend cannot run without 019, so never combine this with the current backend.
6. **Verify:** test login → start → answer → submit on staging, then run the audit query.
7. **Last resort** (data corruption only): restore the section 0 snapshot. Any attempts recorded after the snapshot are lost.

## 9. Sign-off

| Area | Result | Tester | Date |
|---|---|---|---|
| Database migration | | | |
| Backend / frontends deployed | | | |
| Camera / microphone / fullscreen | | | |
| Face recognition | | | |
| Proctoring | | | |
| Device session | | | |
| Exam timer | | | |
| Admin monitoring | | | |
| Audit query clean | | | |

Production deployment is a separate, later decision.
