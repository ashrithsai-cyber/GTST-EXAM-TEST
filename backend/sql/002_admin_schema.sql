-- =====================================================================
-- GTST+ Exam Admin Schema
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001_exam_schema.sql (EXAM_SUPABASE_URL /
-- EXAM_SUPABASE_SERVICE_ROLE_KEY). Idempotent — safe to re-run via
-- `if not exists` guards. Does not modify anything in
-- 001_exam_schema.sql, and has no connection to the Registration
-- Supabase whatsoever.
--
-- No password or password hash is seeded here. The first admin is
-- created out of band by backend/src/scripts/createSuperAdmin.js, which
-- hashes the password locally (bcrypt) before insert. This file never
-- contains a credential.
--
-- Roles: there is a SINGLE role, "admin" — every admin can manage every
-- feature. (Existing databases created before this: run
-- backend/sql/008_single_admin_role.sql to migrate any legacy
-- "super_admin" rows and tighten the constraint.)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- admin_users — one row per operator of the Exam Admin Dashboard.
-- Entirely separate from exam_candidates (students) and from anything
-- in the Registration Supabase.
-- ---------------------------------------------------------------------
create table if not exists admin_users (
    id             uuid primary key default gen_random_uuid(),
    name           text not null,
    email          text not null unique,
    password_hash  text not null,
    role           text not null default 'admin' check (role = 'admin'),
    is_active      boolean not null default true,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    last_login_at  timestamptz
);

create index if not exists idx_admin_users_email on admin_users(email);

-- ---------------------------------------------------------------------
-- admin_audit_logs — append-only record of admin mutations (exam,
-- subject, question, and admin-user changes). The application only
-- ever inserts into this table, never updates or deletes rows.
-- ---------------------------------------------------------------------
create table if not exists admin_audit_logs (
    id            uuid primary key default gen_random_uuid(),
    admin_id      uuid not null references admin_users(id) on delete cascade,
    action        text not null,
    resource_type text not null,
    resource_id   text,
    metadata      jsonb,
    created_at    timestamptz not null default now()
);

create index if not exists idx_admin_audit_logs_admin on admin_audit_logs(admin_id);
create index if not exists idx_admin_audit_logs_created on admin_audit_logs(created_at);

-- ---------------------------------------------------------------------
-- RLS — enabled with zero policies, the same default-deny pattern used
-- throughout 001_exam_schema.sql. Only the backend's service_role
-- client (which bypasses RLS by design) ever queries these tables; this
-- blocks the anon/authenticated roles entirely as defense in depth.
-- ---------------------------------------------------------------------
alter table admin_users enable row level security;
alter table admin_audit_logs enable row level security;
