# Deployment guide

For the team deploying the GTST Exam Portal. Do the steps in order. Rehearse
the whole flow on **staging** ([`STAGING_CHECKLIST.md`](../STAGING_CHECKLIST.md))
before production.

```
Student portal   https://exam.your-domain.com          → static files (dist/)
Admin dashboard  https://admin.your-domain.com/admin/  → static files (admin-frontend/dist/)
Backend API      https://api.your-domain.com           → Node.js (backend/)
                        │
                        ├─► Registration Supabase project (read-only lookup)
                        └─► Exam Supabase project (Postgres + Storage)
```

Domain names here are placeholders. Any domains work as long as the CORS
variables and `VITE_API_URL` match them exactly.

---

## 0. Before you start

- [ ] **Rotate secrets.** The current Supabase service-role keys and JWT secrets
      were found in `backend/.env` inside a project archive (`GTST-EXAM-PORTEL.zip`).
      Treat them as exposed. In each Supabase project, create new secret
      (service-role) keys and revoke the old ones. Generate two new JWT secrets.
      Changing the JWT secrets logs every user out, so do it **before** the exam,
      not during it.
- [ ] Node.js **20+** on the backend host.
- [ ] HTTPS certificates for all three hostnames.
- [ ] Database backup / point-in-time recovery enabled on the exam project.

## 1. Supabase (exam project)

1. **Migrations.** In the SQL Editor, run `backend/sql/001_*.sql` … `023_*.sql`
   **in numeric order**. Fresh database: all 23. Existing database: only those not
   yet applied. `017`–`023` are required for the matching backend features; apply
   only after reviewing the target database and backup.
   Never re-run `001` on an existing database. Details: [`backend/sql/README.md`](../backend/sql/README.md).
2. **Verify** (expect 12 rows and 1 row):
   ```sql
   select proname from pg_proc where proname in
     ('init_exam_attempt','save_exam_answer','submit_exam_attempt','expire_exam_attempts',
      'acquire_student_login_session','touch_student_login_session','assert_exam_login_session',
      'start_exam_attempt','block_exam_attempt','admin_release_student_login_session',
      'admin_reset_exam_attempts','admin_delete_exam_completely');
   select tgname from pg_trigger where tgname = 'exam_sessions_status_guard';
   ```
   Then run `backend/sql/checks/attempt_consistency_audit.sql`. Every check should be `0`.
3. **RLS:** enabled on every table by the migrations, with no policies. **Do not add
   policies** for `anon` / `authenticated`. The anon key is not used anywhere.
4. **Storage buckets** (created by the migrations). Confirm:
   `mock-videos` public · `exam-branding` public · `system-check-screenshots` **private**.
5. **Seed data:** migration `001` creates exam `GTST-2026` with 60 placeholder
   questions. Replace or deactivate it so the real exam is the only ACTIVE one.
6. **Compute size:** see §6. The free/nano tier is not suitable for 400 concurrent students.

**Registration project:** no changes. The backend reads `registrations`
(`registration_id`, `hall_ticket_number`, `full_name`, `student_class`,
`payment_status`) with its service-role key.

## 2. Backend

| Setting | Value |
|---|---|
| Root directory | `backend/` |
| Install | `npm ci --omit=dev` |
| Build | none |
| Start | `npm start` (= `node src/server.js`) |
| Port | `PORT` (default `5000`) |
| Health check | `GET /api/health` → `{"success":true,"server":"online",…}` |
| Node | ≥ 20 |

### Environment variables

| Variable | Required | Rule |
|---|---|---|
| `NODE_ENV` | yes | `production`. Disables the dev localhost/LAN CORS allowance |
| `PORT` | host-dependent | Port to listen on |
| `TRUST_PROXY` | if proxied | Number of proxies in front (usually `1` on PaaS / behind a load balancer). Needed so login rate limits see real client IPs |
| `REGISTRATION_SUPABASE_URL` | yes | `https://<ref>.supabase.co` of the registration project |
| `REGISTRATION_SUPABASE_SERVICE_ROLE_KEY` | yes | Secret key. Backend only |
| `EXAM_SUPABASE_URL` | yes | Exam project URL |
| `EXAM_SUPABASE_SERVICE_ROLE_KEY` | yes | Secret key. Backend only |
| `STUDENT_JWT_SECRET` | yes | ≥ 32 chars, random: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_JWT_SECRET` | yes | ≥ 32 chars, random, **different** from the student secret |
| `STUDENT_JWT_EXPIRES_IN` | no | Default `4h` (renewed by the heartbeat while active) |
| `ADMIN_JWT_EXPIRES_IN` | no | Default `8h` |
| `STUDENT_ALLOWED_ORIGINS` | yes | Exact student-portal origin(s), comma-separated, e.g. `https://exam.your-domain.com` |
| `ADMIN_ALLOWED_ORIGINS` | yes | Exact admin origin(s), e.g. `https://admin.your-domain.com`. Never `*` |
| `EXAM_DATE` | no | Shown only if the active exam has no date set |
| `PREFLIGHT_MAX_AGE_MINUTES` | no | Default `720` |

The server refuses to start if a JWT secret is missing, shorter than 32
characters, or identical to the other.

### CORS

An origin is the scheme + host (+ port): `https://exam.your-domain.com`. No
path, no trailing slash. With `NODE_ENV=production` the backend accepts only the
origins listed in the two variables and answers anything else with
`403 Origin not allowed`.

### Process notes

- Each instance runs a 30-second worker that finalizes overdue attempts. Running
  several instances is safe (`FOR UPDATE SKIP LOCKED`).
- Rate limits are kept **in memory per instance**. With several instances behind a
  load balancer the effective limit is multiplied. That is acceptable, since limits
  only stop scripted abuse.
- Place the backend in the **same region** as the exam Supabase project, because every
  request makes several database round trips.
- Logs contain errors only. No secrets or tokens are logged.

## 3. Student portal

| Setting | Value |
|---|---|
| Root directory | repo root |
| Build-time variable | `VITE_API_URL=https://api.your-domain.com` (in `.env` or the host's build env) |
| Install + build | `npm ci && npm run build` (prebuild copies the MediaPipe WASM) |
| Output directory | `dist/` |
| SPA rewrite | every unknown path → `/index.html` (`/exam`, `/system-check`, …) |

Host requirements:

- **HTTPS** (camera and microphone need a secure context).
- Serve `.wasm` as `application/wasm` and **compressed** (gzip/brotli). Each
  student downloads about 11.8 MB raw / 3.4 MB compressed of face-detection WASM. For
  400 students that is about 1.4 GB compressed versus 4.7 GB raw. If students sit
  in one hall on a shared connection, stagger check-in or confirm the bandwidth.
- Cache hashed `assets/` and `mediapipe/` long-term. Do **not** long-cache `index.html`.
- After building, confirm `dist/mediapipe/blaze_face_short_range.tflite` and
  `dist/mediapipe/wasm/` exist (face detection is self-hosted; the public CDN is only a fallback).

If `VITE_API_URL` is unset, a production build calls `/api` on its own origin.
That works only if a reverse proxy routes `/api/*` on the student domain to the backend.

## 4. Admin dashboard

| Setting | Value |
|---|---|
| Root directory | `admin-frontend/` |
| Build-time variable | `VITE_API_URL=https://api.your-domain.com` |
| Install + build | `npm ci && npm run build` |
| Output directory | `admin-frontend/dist/` |
| URL path | **`/admin/`**. The build uses `base: '/admin/'`, so all asset URLs start with `/admin/` |
| SPA rewrite | unknown paths under `/admin/` → `/admin/index.html` |

Because of the `/admin/` base, choose one of:

- **Separate domain:** publish the contents of `dist/` inside an `admin/` folder,
  so `https://admin.your-domain.com/admin/` serves `index.html`, and redirect `/` to `/admin/`.
- **Same domain as the student portal:** route `https://exam.your-domain.com/admin/*`
  to the admin files (the dev setup already proxies `/admin` this way). Then
  `ADMIN_ALLOWED_ORIGINS` is the student domain's origin.

Example Nginx (single domain, both frontends plus API proxy):

```nginx
server {
  listen 443 ssl http2;
  server_name exam.your-domain.com;
  types { application/wasm wasm; }
  gzip on; gzip_types application/wasm application/javascript text/css;

  location /admin/ { alias /srv/gtst/admin/; try_files $uri $uri/ /admin/index.html; }
  location /api/   { proxy_pass http://127.0.0.1:5000; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
  location /       { root /srv/gtst/student; try_files $uri /index.html; }
}
```

With this layout you can leave `VITE_API_URL` unset (same-origin `/api`), set
`TRUST_PROXY=1`, and set both CORS variables to `https://exam.your-domain.com`.

## 5. First-run configuration

1. On the backend host: `cd backend && node src/scripts/createSuperAdmin.js`.
2. Log in to the admin dashboard and set:
   - exactly **one** ACTIVE exam, its classes (names must match the students'
     `student_class`, e.g. "Class 10"), subjects, questions (or Excel import),
     seconds per question, and optionally start time + duration
   - **Exam Settings**: camera, check-in photo, microphone, fullscreen, face
     detection, proctoring, tab-switch and network monitoring
   - proctoring rules, branding, and the instruction video
3. Rehearse with a test registration on the production URL.

## 6. Capacity for ~400 concurrent students

Per student during the exam: a presence ping every 10 s, a session heartbeat every
30 s, an exam re-sync every 30 s, a draft save per selection, and one answer save per
question. Every authenticated request also renews the device lease.

| Load | Estimate at 400 students |
|---|---|
| HTTP requests to the backend | ~85 req/s steady |
| Database calls (PostgREST/RPC) | ~250–300/s steady |
| Burst when a per-question timer expires for everyone at once (scheduled start) | ~1,600 calls within a few seconds, once per question |
| Burst at the scheduled start | 400 attempt creations within ~8 s (waiting-room poll interval) |
| Admin Live Students / Violations pages | Live Students fetches compact event summaries for the displayed session page; Violations loads history initially, then polls only events after its timestamp cursor |

Recommendations:

- Use **at least the Small compute add-on** on the exam Supabase project (Medium to be
  safe) and check the API connection-pool settings. Watch the Supabase
  dashboard (CPU, connections, API latency) during the rehearsal.
- **Run the controlled staging-only rehearsal** in
  [`STAGING_CHECKLIST.md` §10](../STAGING_CHECKLIST.md#10-controlled-staging-load-rehearsal-400-students)
  with ~400 isolated test students through login → preflight → start → answer
  → submit, including a synchronized question timeout. This has **not** been
  run or passed; capacity remains unverified until measured results are
  recorded and reviewed.
- Keep the number of admins on Live Students / Violations during the exam small (2–3).
- One Node instance handles this load. Two instances give failover.

## 7. Go-live verification

- [ ] `GET https://api.your-domain.com/api/health` returns `success: true`
- [ ] Student site: login page shows branding; no CORS errors in the browser console
- [ ] Admin site loads at `/admin/`, login works, Dashboard / Live Students / Violations load
- [ ] Test student completes: login → system check → rules → exam → submit; the admin sees Completed and the answer sheet
- [ ] Backend logs: no `[attemptExpiry]` or `[student session]` errors
- [ ] `attempt_consistency_audit.sql` all zeros after the rehearsal

## 8. Rollback

See [`STAGING_CHECKLIST.md` §8](../STAGING_CHECKLIST.md#8-rollback-procedure). In
short: keep the previous backend build and both previous `dist/` folders. Roll back
the application first and leave applied migrations in place; the historical
migration set is not uniformly safe to replay or roll back on populated data.
