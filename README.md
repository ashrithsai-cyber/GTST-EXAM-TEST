# GTST Exam Portal

Online, proctored scholarship examination platform for GTST+ (Global Talent
Scholarship Test Plus). Three applications share one backend:

| App | Folder | Stack | Dev port |
|---|---|---|---|
| Student portal | `/` (repo root) | React 19 + Vite 8, MediaPipe face detection | 5173 |
| Admin dashboard | `admin-frontend/` | React 19 + TypeScript + Tailwind 3 + Vite 8 | 5174 |
| Backend API | `backend/` | Node.js 20+, Express 5 | 5000 |

Deployment guide: [`docs/deployment.md`](docs/deployment.md) ·
API reference: [`docs/api.md`](docs/api.md) ·
Database: [`docs/database.md`](docs/database.md) ·
Audit report: [`docs/FINAL_AUDIT_REPORT.md`](docs/FINAL_AUDIT_REPORT.md) ·
Staging test plan: [`STAGING_CHECKLIST.md`](STAGING_CHECKLIST.md)

---

## 1. Project overview

Students log in with their **Registration ID + Hall Ticket Number**, pass a
system check (camera, microphone, fullscreen, face detection, check-in photo),
accept the proctoring rules, and take a timed, sequential, multiple-choice exam.
Every answer is saved server-side as it is given. Proctoring events (tab
switches, fullscreen exits, missing or multiple faces, camera/mic loss, …) are
recorded for admin review. They never block or end an attempt.

Admins manage exams, classes, subjects and questions (including Excel import),
watch students live, review violations and check-in photos, inspect each
student's answer sheet, and publish results.

## 2. System architecture

```
 Student portal (browser) ─┐                       ┌─ Registration Supabase project
                           ├─ HTTPS ─► Backend API ┤   (read-only: registrations)
 Admin dashboard (browser) ┘          (Express)    └─ Exam Supabase project
                                                       (Postgres + Storage: all exam data)
```

- **Only the backend talks to Supabase**, using service-role keys. Neither
  frontend contains a Supabase client or any key.
- **Two Supabase projects.** The *registration* project is read at login to
  verify credentials and `payment_status = 'SUCCESS'`. The *exam* project holds
  everything else.
- **Students** get a JWT signed with `STUDENT_JWT_SECRET`. A database
  lease enforces **one active device per student**.
- **Admins** get a separate JWT signed with `ADMIN_JWT_SECRET`. Every admin
  request re-checks that the admin account is still active.
- **The server is authoritative** for the current question, the timers, the
  deadline and scoring. `correct_option` is never sent to a student.
  Answer save, submit and attempt start each run as a single database
  transaction (Postgres functions, migrations `017`–`019`).
- A 30-second background worker in the backend finalizes attempts whose
  deadline has passed, even if the browser was closed.

## 3. Technology stack

| Area | Technology |
|---|---|
| Student frontend | React 19, React Router 7, Vite 8, `@mediapipe/tasks-vision` (face detection, self-hosted WASM + model) |
| Admin frontend | React 19, TypeScript, Tailwind CSS 3, lucide-react, Vite 8 |
| Backend | Node.js ≥ 20, Express 5, helmet, cors, express-rate-limit, jsonwebtoken, bcrypt, multer, exceljs |
| Database | Supabase Postgres (exam project), RLS enabled on every table |
| Authentication | Custom JWTs (students: Registration ID + Hall Ticket; admins: email + bcrypt password). Supabase Auth is **not** used |
| Storage | Supabase Storage buckets: `mock-videos` (public), `exam-branding` (public), `system-check-screenshots` (**private**) |
| Realtime | None. Admin pages poll every 10–15 s; students send a presence ping every 10 s |
| Tests | `node --test` (backend + frontend units), PGlite real-migration tests, Chrome end-to-end flow |

## 4. Project structure

```
GTST-EXAM-PORTEL/
├── src/                     Student portal
│   ├── components/          Header/Footer, route guards, waiting room, camera preview, API client (components/utils/api.js)
│   ├── context/             Auth, branding, system-check gates, exam state (ExamContext)
│   ├── hooks/               Camera, microphone, fullscreen, face detection, back-navigation guard
│   ├── pages/               Landing → Confirm → Dashboard → System Check → Rules → Exam → Summary → Success / Result
│   ├── services/            Backend API calls
│   └── utils/               Constants, server-anchored exam clock
├── public/mediapipe/        Face-detection model (committed) + wasm/ (generated at dev/build time)
├── scripts/                 copy-mediapipe-assets.mjs (runs before dev/build)
├── test/                    Frontend unit tests + Chrome end-to-end flow
├── admin-frontend/          Admin dashboard (served under /admin/)
│   └── src/
│       ├── newadmin/        Pages, UI components, types, adapters
│       └── services/        API client, admin API wrappers, monitoring aggregation
├── backend/
│   ├── sql/                 Exam-database migrations 001–023, read-only audit query, rollback scripts
│   ├── src/
│   │   ├── config/          Supabase clients (service role, server-side only)
│   │   ├── controllers/     Request handlers; _examShared.js holds exam/attempt logic
│   │   ├── middleware/      Student JWT + device lease, admin JWT, rate limiters, upload limits
│   │   ├── routes/          /api/exam/* (students), /api/admin/* (admins)
│   │   ├── scripts/         createSuperAdmin / resetAdminPassword CLIs
│   │   ├── utils/           Attempt-expiry worker, sessions, audit log, validation
│   │   └── server.js        App entry point
│   └── test/                API, security, session, migration and concurrency tests
├── docs/                    Deployment, API, database docs and the audit report
├── STAGING_CHECKLIST.md     Staging rollout and real-device test plan
└── .env.example             Student-portal build variables (each app has its own)
```

The student portal lives at the repo root rather than in a `frontend/` folder.
This is intentional: build scripts, tests and the staging checklist all depend on
that layout.

## 5. Requirements

- **Node.js 20 or newer** (tested with Node 24) and npm 10+
- Two Supabase projects: registration (existing) and exam (new, see §11)
- **HTTPS** in every deployed environment, because browsers block camera and microphone on insecure origins
- Students: a current Chrome or Edge browser on a laptop or desktop with webcam and microphone. Browsers without the Fullscreen API (e.g. iPhone Safari) cannot start the exam when fullscreen is required

## 6. Installation

```bash
# Backend
cd backend
npm ci
cp .env.example .env          # fill in, see §7

# Student portal (repo root)
cd ..
npm ci

# Admin dashboard
cd admin-frontend
npm ci
```

## 7. Environment variables

Each app has its own template. Copy it to `.env` in the same folder. Real
`.env` files are git-ignored and must **never** be committed or shared.

| File | Variables | Exposed to browser? |
|---|---|---|
| `backend/.env.example` | `NODE_ENV`, `PORT`, `TRUST_PROXY`, `REGISTRATION_SUPABASE_URL`, `REGISTRATION_SUPABASE_SERVICE_ROLE_KEY`, `EXAM_SUPABASE_URL`, `EXAM_SUPABASE_SERVICE_ROLE_KEY`, `STUDENT_JWT_SECRET`, `STUDENT_JWT_EXPIRES_IN`, `ADMIN_JWT_SECRET`, `ADMIN_JWT_EXPIRES_IN`, `ADMIN_ALLOWED_ORIGINS`, `STUDENT_ALLOWED_ORIGINS`, `EXAM_DATE`, `PREFLIGHT_MAX_AGE_MINUTES` | **No**: server secrets |
| `.env.example` (root) | `VITE_API_URL` | Yes (public URL only) |
| `admin-frontend/.env.example` | `VITE_API_URL` | Yes (public URL only) |

- No anon key is needed anywhere, and neither frontend needs any Supabase variable.
- `VITE_API_URL` is baked in at **build** time. Rebuild after changing it.
- The backend **refuses to start** if a JWT secret is missing, shorter than 32
  characters, or identical to the other one.

Full table with rules: [`docs/deployment.md`](docs/deployment.md#environment-variables).

## 8. Development

Run each app in its own terminal:

```bash
cd backend && npm run dev            # API on http://localhost:5000
npm run dev                          # student portal on http://localhost:5173 (repo root)
cd admin-frontend && npm run dev     # admin on http://localhost:5174/admin/
```

For local development set `ADMIN_ALLOWED_ORIGINS=http://localhost:5174` in
`backend/.env` and leave `NODE_ENV` unset (or `development`). The student portal
on port 5173 (localhost or a private LAN IP) is then allowed automatically. With
`VITE_API_URL` unset, the dev frontends call `<page host>:5000`.

Create the first admin account (interactive):

```bash
cd backend && node src/scripts/createSuperAdmin.js
```

### Checks

```bash
# Student portal (repo root). Lint also covers backend/
npm test && npm run lint && npm run build
npm run test:browser          # Chrome end-to-end flow; needs Chrome and a built dist/

# Backend
cd backend && npm test && npm run check

# Admin dashboard
cd admin-frontend && npm run typecheck && npm run build
```

Optional multi-connection concurrency tests need a **local** PostgreSQL:
`cd backend && TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres npm run test:postgres`.

## 9. Production build

```bash
# Student portal → dist/
echo "VITE_API_URL=https://api.your-domain.com" > .env
npm ci && npm run build

# Admin dashboard → admin-frontend/dist/ (asset paths are under /admin/)
cd admin-frontend
echo "VITE_API_URL=https://api.your-domain.com" > .env
npm ci && npm run build

# Backend: no build step
cd ../backend
npm ci --omit=dev
NODE_ENV=production npm start
```

## 10. Deployment

Summary (step-by-step in [`docs/deployment.md`](docs/deployment.md)):

1. **Supabase:** verify applied migration state and a restorable backup, then apply only pending migrations `001`–`021` in order on the exam project; check buckets, then create the first admin.
2. **Backend:** deploy `backend/` to a Node host over HTTPS, set every backend variable, `NODE_ENV=production`, and `TRUST_PROXY` if behind a proxy. Check `GET /api/health`.
3. **Student portal:** build with `VITE_API_URL`, deploy `dist/` to a static host with an SPA rewrite to `index.html`, and `.wasm` served compressed.
4. **Admin dashboard:** build with `VITE_API_URL`, deploy `admin-frontend/dist/` so it is served **under `/admin/`**, with an SPA rewrite to `/admin/index.html`.
5. **CORS:** `STUDENT_ALLOWED_ORIGINS` and `ADMIN_ALLOWED_ORIGINS` must equal the exact HTTPS origins of the two sites.
6. Run [`STAGING_CHECKLIST.md`](STAGING_CHECKLIST.md) on staging, then a load test, before the live exam.

## 11. Database

Migrations live in [`backend/sql/`](backend/sql/README.md). Verify the applied
state and backup first, then run only pending files in numeric order, 001 → 023.
Do not blindly replay historical migrations on a populated database: 001 is
incompatible after 010, which includes destructive legacy/sample-data cleanup.
Apply pending 017–023 before deploying the matching backend. Data model and
integrity notes: [`docs/database.md`](docs/database.md).

> Migration `001` seeds a sample exam `GTST-2026` with 60 placeholder questions.
> Before the live exam, an admin must make sure the **real** exam is the only
> ACTIVE one, and edit or remove the seed content.

## 12. Admin access

- No default credentials exist. The first admin is created on the server with
  `node src/scripts/createSuperAdmin.js` (prompts for name, email, password ≥ 10 characters).
- Further admins: **Admin Management** page. Forgotten password:
  `node src/scripts/resetAdminPassword.js` on the server.
- There is a single `admin` role. Deactivating an admin takes effect on their next request.
- Admin actions (exam edits, device-session releases, …) are written to **Audit Logs**.

## 13. Exam flow

```
Login (Registration ID + Hall Ticket)
 → Confirm details → Dashboard (exam info)
 → System Check (camera, mic level, fullscreen, face, check-in photo)   [server-recorded]
 → Proctoring Rules + instruction video, accept rules                  [server-recorded]
 → (Waiting room until the scheduled start, if one is set)
 → Exam: one question at a time, forward-only, per-question timer + overall deadline
 → Summary/review → Submit (or automatic submit at the deadline)
 → Success page (redirects to the GTST website) · Result page once an admin publishes results
```

- Answers are saved on every selection (draft) and locked when the student moves on.
  Refresh, network loss and device reconnects resume at the same question.
- Timers are anchored to server time and a monotonic browser clock, so changing the PC clock gains nothing.
- One device at a time. If a device fails, an admin can release it under
  **Student Data → student → Device Session** (reason required, audit-logged).

## 14. Proctoring

| Event | Trigger | Gated by setting |
|---|---|---|
| `NO_FACE` / `MULTIPLE_FACE` | Face detection (~3 s grace for no face) | Face detection |
| `CAMERA_DISABLED` / `MICROPHONE_DISABLED` | Track ended, muted or unplugged | Camera / Microphone |
| `TAB_SWITCH` / `WINDOW_BLUR` | Page hidden or focus lost (one action is coalesced into one event) | Tab-switch monitoring |
| `FULLSCREEN_EXIT` | Leaving fullscreen (blocking overlay until restored) | Fullscreen |
| `RIGHT_CLICK`, `EXAM_LEFT` | Context menu; leaving the exam page | Proctoring (master switch) |
| `COPY_PASTE` | Copy/cut/paste (blocked; informational only) | Proctoring |
| `NETWORK_DISCONNECT` / `NETWORK_RECONNECT` | Connectivity (informational only) | Network monitoring |

Each event is stored in `exam_events` (session → student and exam, type,
timestamp, message). Violations increment `exam_sessions.proctoring_warning_count`.
**Violations are captured for review only and never block the attempt.** Admins
review them on the **Violations** page. Events are rate-limited to 30 per minute per
student, and disabled categories are not recorded.

## 15. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Backend exits with `Refusing to start: …JWT_SECRET…` | Set both JWT secrets: ≥ 32 characters and different from each other |
| Browser console: CORS error, API returns `403 Origin not allowed` | Origin missing from `STUDENT_ALLOWED_ORIGINS` / `ADMIN_ALLOWED_ORIGINS` (exact scheme + host, no trailing slash) |
| Frontend calls the wrong host or `/api` on itself | `VITE_API_URL` was not set at build time. Set it and rebuild |
| Admin dashboard shows a blank page | It was not served under `/admin/`. See the deployment guide |
| Deep link such as `/exam` returns 404 on refresh | Static host is missing the SPA rewrite to `index.html` |
| "Camera/Microphone access requires a secure connection" | Site not served over HTTPS |
| Backend logs `[student session] … Apply database migration 018` or `[attemptExpiry]` errors | Migrations 017–019 not applied to the exam project |
| Every student hits rate limits / shares one limit | Behind a proxy without `TRUST_PROXY` set |
| "Your exam is already active on another device." | Single-device rule. Wait 10 min of inactivity, or an admin releases the device session |
| Face detection never loads | `dist/mediapipe/` missing from the deploy, or `.wasm` not served as `application/wasm` |

## 16. Production checklist

- [ ] **All Supabase service-role keys and both JWT secrets rotated** (see the audit report; the current values were found inside a project archive)
- [ ] Migration state verified and pending migrations through `021` applied; `backend/sql/checks/attempt_consistency_audit.sql` reports all zeros
- [ ] Buckets: `mock-videos` public, `exam-branding` public, `system-check-screenshots` **private**
- [ ] Backend: `NODE_ENV=production`, both `*_ALLOWED_ORIGINS` set to real HTTPS origins, `TRUST_PROXY` set if proxied, health check OK
- [ ] Both frontends built with the production `VITE_API_URL`; everything served over HTTPS
- [ ] Student host: SPA rewrite, `.wasm` served compressed as `application/wasm`; admin served under `/admin/`
- [ ] First admin created; exactly one ACTIVE exam with the real classes, subjects and questions; seed exam content reviewed
- [ ] Exam Settings, proctoring rules, branding and instruction video reviewed
- [ ] Supabase compute sized for the exam and a load test of ~400 simulated students passed (see `docs/deployment.md`)
- [ ] [`STAGING_CHECKLIST.md`](STAGING_CHECKLIST.md) completed on real devices
- [ ] Database backup / PITR confirmed before the exam
- [ ] No question-bank structure changes (add/delete/reorder) while students are writing
