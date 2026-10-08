-- =====================================================================
-- GTST+ Classes Hierarchy
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-009. Idempotent — safe to re-run.
--
-- Restructures Exam -> Subjects -> Questions into
-- Exam -> Classes -> Subjects -> Questions, and removes the FINAL/MOCK
-- concept entirely. exam_type (003_admin_extensions.sql) only ever let
-- the admin dashboard show a Final/Mock tab for organizing draft
-- content — the 4 MOCK-SECTION-* rows it seeded were permanently
-- INACTIVE placeholder rows, never delivered to a student. With only
-- one kind of exam left, exam_type becomes dead weight, so it (and
-- those 4 rows) are dropped here rather than kept around unused.
--
-- Verified via a live read-only query immediately before writing this
-- migration: subjects/questions/exam_sessions/exam_answers all have
-- ZERO rows. There is no real exam content to preserve, so this is a
-- direct column repoint rather than a backfill. exam_candidates (5 real
-- rows) and its student_class values are untouched by this file.
--
-- DEPLOY ORDER: the exam_sessions.class_id NOT NULL constraint below
-- must land at the same time as the updated backend (the old backend
-- code does not set class_id when creating a session) — run this SQL
-- immediately before/alongside restarting the backend, not hours apart.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- classes — sits between exams and subjects. One row per grade level an
-- admin creates under an exam (e.g. "Class 6", "Class 7"). No status
-- column: activation is exam-level only (see the partial unique index
-- below), not per-class.
-- ---------------------------------------------------------------------
create table if not exists classes (
    id             uuid primary key default gen_random_uuid(),
    exam_id        uuid not null references exams(id) on delete cascade,
    class_name     text not null,
    display_order  integer not null,
    created_at     timestamptz not null default now(),
    unique (exam_id, display_order),
    unique (exam_id, class_name)
);

alter table classes enable row level security;

-- ---------------------------------------------------------------------
-- subjects — repoint from exam_id to class_id. subjects has ZERO rows
-- (verified), so this is a plain rename + FK repoint, not a data
-- migration. Guarded so re-running this file after it has already
-- applied is a no-op.
-- ---------------------------------------------------------------------
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_name = 'subjects' and column_name = 'exam_id'
    ) and not exists (
        select 1 from information_schema.columns
        where table_name = 'subjects' and column_name = 'class_id'
    ) then
        alter table subjects rename column exam_id to class_id;
    end if;
end $$;

alter table subjects drop constraint if exists subjects_exam_id_fkey;

-- A fresh database still holds 001's seeded subjects, whose renamed
-- class_id column contains exam ids. Give each such exam one default
-- class so the FK below can be added. No-op once every subject has a
-- class (the production state when this file was first applied).
do $$
declare v_exam uuid; v_class uuid;
begin
    for v_exam in select distinct s.class_id from subjects s
        where not exists (select 1 from classes c where c.id = s.class_id)
          and exists (select 1 from exams e where e.id = s.class_id)
    loop
        insert into classes (exam_id, class_name, display_order)
        values (v_exam, 'Class 10', 1) returning id into v_class;
        update subjects set class_id = v_class where class_id = v_exam;
    end loop;
end $$;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'subjects_class_id_fkey') then
        alter table subjects
            add constraint subjects_class_id_fkey
            foreign key (class_id) references classes(id) on delete cascade;
    end if;
end $$;

-- Cosmetic renames of the two original unique constraints, which kept
-- working automatically after the column rename above (Postgres tracks
-- constraints by column position, not name) — this just makes `\d
-- subjects` stop showing a stale "exam_id" substring. Each guarded so
-- re-running this file is safe once the rename has already happened.
do $$
begin
    if exists (select 1 from pg_constraint where conname = 'subjects_exam_id_subject_key_key') then
        alter table subjects rename constraint subjects_exam_id_subject_key_key to subjects_class_id_subject_key_key;
    end if;
end $$;

do $$
begin
    if exists (select 1 from pg_constraint where conname = 'subjects_exam_id_display_order_key') then
        alter table subjects rename constraint subjects_exam_id_display_order_key to subjects_class_id_display_order_key;
    end if;
end $$;

-- ---------------------------------------------------------------------
-- exams — drop the FINAL/MOCK concept and its 4 vestigial rows. There
-- is only "Exam" now. A partial unique index guarantees at most one
-- exam is ever ACTIVE, matching "only the ACTIVE Exam should be
-- available" — the backend's updateExamStatus also deactivates every
-- other exam before activating one, so this is a backstop, not the
-- only thing enforcing it.
-- ---------------------------------------------------------------------
delete from exams where exam_code like 'MOCK-SECTION-%';

alter table exams drop column if exists exam_type;

create unique index if not exists exams_single_active on exams (status) where status = 'ACTIVE';

-- ---------------------------------------------------------------------
-- exam_sessions — gains class_id, resolved once at session start and
-- never re-derived afterwards, so an admin renaming/reordering a class
-- mid-exam can never strand an in-progress student. No ON DELETE
-- cascade — same reasoning as the existing exam_id FK: a class with
-- live sessions must not be silently deletable. 0 rows today, so NOT
-- NULL is safe to add directly.
-- ---------------------------------------------------------------------
alter table exam_sessions add column if not exists class_id uuid references classes(id);
alter table exam_sessions alter column class_id set not null;
