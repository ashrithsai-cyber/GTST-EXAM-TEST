-- =====================================================================
-- GTST+ Single Admin Role
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-007. Idempotent — safe to re-run.
--
-- The admin role system is now flat: a SINGLE role, "admin". Every
-- authenticated admin can manage every dashboard feature (exam settings,
-- questions, videos, proctoring rules, exams, monitoring, violations,
-- results, admin management, audit logs). This migration:
--   1. rewrites any legacy "super_admin" rows to "admin", and
--   2. tightens the role CHECK constraint (and default) so only "admin"
--      can ever be stored going forward.
--
-- Authentication is unchanged — the dashboard still requires a valid
-- admin login and JWT (see backend/src/controllers/adminAuth.controller.js
-- and backend/src/middleware/adminJwtAuth.js). This only removes the
-- role DISTINCTION, never the login.
-- =====================================================================

-- 1. Flatten every existing role to "admin" (no-op if already flat).
update admin_users set role = 'admin' where role is distinct from 'admin';

-- 2. Replace the old two-value CHECK with an admin-only one, and make
--    "admin" the column default. Dropping by the constraint's default
--    name (table_column_check); harmless if it was already dropped.
alter table admin_users drop constraint if exists admin_users_role_check;
alter table admin_users add constraint admin_users_role_check check (role = 'admin');
alter table admin_users alter column role set default 'admin';
