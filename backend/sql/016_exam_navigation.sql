-- =====================================================================
-- 016 — student exam navigation state
--
-- Adds server-owned visited/bookmark/review state per session/question.
-- Answer values remain in exam_answers so existing scoring continues to
-- use the same source of truth.
-- =====================================================================

create table if not exists exam_question_states (
    id                uuid primary key default gen_random_uuid(),
    session_id        uuid not null references exam_sessions(id) on delete cascade,
    question_id       uuid not null references questions(id) on delete cascade,
    visited           boolean not null default false,
    bookmarked        boolean not null default false,
    marked_for_review boolean not null default false,
    started_at        timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (session_id, question_id)
);

alter table exam_question_states add column if not exists started_at timestamptz;

create index if not exists idx_exam_question_states_session
    on exam_question_states(session_id);

alter table exam_question_states enable row level security;
