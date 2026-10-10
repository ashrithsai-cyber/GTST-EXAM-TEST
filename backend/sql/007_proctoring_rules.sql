-- =====================================================================
-- GTST+ Admin-Managed Proctoring Rules
--
-- Run this once in the Supabase SQL Editor for the SAME dedicated exam
-- project as 001-006. Idempotent — safe to re-run. Purely additive.
--
-- exam_rules backs the new Admin "Proctoring Rules" page and the student
-- Exam Proctoring & Rules page (src/pages/ExamProctoringRulesPage.jsx),
-- which previously rendered a HARDCODED rules array. The student page
-- now fetches GET /api/exam/rules and shows exactly the active rules the
-- admin has configured here — add / edit / enable-disable / reorder /
-- delete, all reflected on the student portal on its next load.
--
-- Until this migration runs the student page silently falls back to its
-- bundled default rules, so an unmigrated environment behaves exactly as
-- before. The seed below inserts those same 10 defaults (only when the
-- table is empty) so nothing changes visually the moment it's migrated.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- exam_rules — the ordered list of proctoring rules shown to students on
-- the Exam Proctoring & Rules page. display_order controls the order;
-- is_active hides a rule from students without deleting it.
-- ---------------------------------------------------------------------
create table if not exists exam_rules (
    id             uuid primary key default gen_random_uuid(),
    rule_text      text not null,
    display_order  integer not null default 0,
    is_active      boolean not null default true,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    updated_by     uuid references admin_users(id)
);

create index if not exists exam_rules_order_idx on exam_rules (display_order, created_at);

-- Seed the exact 10 rules the student page used to hardcode — but ONLY
-- if the table is currently empty, so re-running never duplicates them
-- and never overwrites an admin's later edits.
insert into exam_rules (rule_text, display_order)
select v.rule_text, v.display_order
from (
    values
        ('Log in and complete all system checks only during the permitted exam window.', 1),
        ('Keep your camera and microphone switched on and unmuted for the entire duration of the exam.', 2),
        ('Remain visible within the camera frame at all times and do not leave your seat.', 3),
        ('Do not use mobile phones, books, notes, or any other external assistance.', 4),
        ('Do not communicate with any other person during the examination.', 5),
        ('Do not switch tabs, minimize the window, or exit fullscreen mode once the exam has started.', 6),
        ('Copying, screenshotting, recording or sharing exam content in any form is strictly prohibited.', 7),
        ('Report any technical issue immediately using the Help / Support option — do not close the browser.', 8),
        ('The exam will be automatically submitted once the time limit expires; no extensions will be granted.', 9),
        ('Violation of any of the above rules may lead to disqualification and cancellation of your candidature.', 10)
) as v(rule_text, display_order)
where not exists (select 1 from exam_rules);

alter table exam_rules enable row level security;
