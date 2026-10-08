-- =====================================================================
-- GTST+ Exam Schema
--
-- Run this once in the Supabase SQL Editor for the DEDICATED EXAM
-- PROJECT — the one backend/.env points EXAM_SUPABASE_URL /
-- EXAM_SUPABASE_SERVICE_ROLE_KEY at. It is idempotent (safe to re-run)
-- via `if not exists` / `on conflict` guards.
--
-- This is a fully SEPARATE Supabase project from the Registration
-- Portal's project (registrations, payments, admin, etc.) — do not run
-- this against that project. This schema holds NO foreign key into that
-- other database (Postgres can't constrain across separate project
-- instances anyway) and does NOT duplicate the registrations table.
--
-- Instead, `exam_candidates` is this project's own minimal identity
-- table: just enough to know who a candidate is and to give
-- exam_sessions something real to foreign-key against *within this
-- database*. `registration_id` is the shared identifier — the same
-- text code (e.g. "GTST26100094") the Registration System already uses
-- — not that system's internal uuid. The backend verifies a student's
-- Registration ID + Hall Ticket Number against the Registration
-- Supabase at login (unchanged, and never duplicated here), then
-- get-or-creates the matching exam_candidates row here and issues a JWT
-- carrying that row's local id. Every exam endpoint trusts the JWT, not
-- a cross-database constraint.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- exam_candidates — this project's own minimal identity anchor. One row
-- per student who has ever logged into the exam portal, get-or-created
-- at login time once their Registration ID + Hall Ticket Number have
-- been verified against the (separate) Registration Supabase.
--
-- Deliberately minimal: just enough identity to run/audit an exam
-- session and display who it belongs to. No aadhaar, no contact
-- details, no payment/document data — that stays in the Registration
-- System and is never duplicated here.
-- ---------------------------------------------------------------------
create table if not exists exam_candidates (
    id                 uuid primary key default gen_random_uuid(),
    registration_id    text not null unique,
    full_name          text,
    student_class      text,
    last_verified_at   timestamptz not null default now(),
    created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- exams — one row per exam offering. Currently just GTST-2026, but kept
-- as its own table since the app may run more than one exam over time.
-- ---------------------------------------------------------------------
create table if not exists exams (
    id                  uuid primary key default gen_random_uuid(),
    exam_code           text not null unique,
    exam_name           text not null,
    status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
    seconds_per_question integer not null default 60,
    created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- subjects — the 4 sections of an exam, in a fixed display order.
-- ---------------------------------------------------------------------
create table if not exists subjects (
    id             uuid primary key default gen_random_uuid(),
    exam_id        uuid not null references exams(id) on delete cascade,
    subject_key    text not null,
    subject_name   text not null,
    display_order  integer not null,
    unique (exam_id, subject_key),
    unique (exam_id, display_order)
);

-- ---------------------------------------------------------------------
-- questions — correct_option lives ONLY here and is never selected by
-- any student-facing query. Only the backend's service-role client
-- reads this column (to score answers), and RLS below denies every
-- other role access to the table outright.
-- ---------------------------------------------------------------------
create table if not exists questions (
    id               uuid primary key default gen_random_uuid(),
    subject_id       uuid not null references subjects(id) on delete cascade,
    question_number  integer not null,
    question_text    text not null,
    passage          text,
    option_a         text not null,
    option_b         text not null,
    option_c         text not null,
    option_d         text not null,
    correct_option   char(1) not null check (correct_option in ('A', 'B', 'C', 'D')),
    marks            integer not null default 1,
    unique (subject_id, question_number)
);

-- ---------------------------------------------------------------------
-- exam_sessions — one row per (candidate, exam). The unique constraint
-- is what prevents a student from ever having two active sessions for
-- the same exam; session creation is a get-or-create against this
-- table. candidate_id is a real foreign key into exam_candidates —
-- entirely local to this database, unlike the old registration_id
-- column it replaces.
--
-- current_subject_index / current_question_index / question_started_at
-- are the server's source of truth for "where is this student right
-- now" — used both to reject answers for any question that isn't the
-- current one (no going back, no replaying) and to recompute the
-- remaining time on the current question after a page refresh.
-- ---------------------------------------------------------------------
create table if not exists exam_sessions (
    id                        uuid primary key default gen_random_uuid(),
    candidate_id              uuid not null references exam_candidates(id) on delete cascade,
    exam_id                   uuid not null references exams(id),
    status                    text not null default 'NOT_STARTED'
                                  check (status in ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'BLOCKED')),
    current_subject_index     integer not null default 0,
    current_question_index    integer not null default 0,
    question_started_at       timestamptz,
    started_at                timestamptz,
    submitted_at              timestamptz,
    last_activity_at          timestamptz not null default now(),
    proctoring_warning_count  integer not null default 0,
    total_score               numeric,
    max_score                 numeric,
    created_at                timestamptz not null default now(),
    unique (candidate_id, exam_id)
);

create index if not exists idx_exam_sessions_candidate on exam_sessions(candidate_id);

-- ---------------------------------------------------------------------
-- exam_answers — one row per (session, question), written once and then
-- immutable from the student's perspective. is_correct is computed by
-- the backend at save time purely for later scoring and is never
-- returned to the student during the exam.
-- ---------------------------------------------------------------------
create table if not exists exam_answers (
    id                  uuid primary key default gen_random_uuid(),
    session_id          uuid not null references exam_sessions(id) on delete cascade,
    question_id         uuid not null references questions(id),
    subject_id          uuid not null references subjects(id),
    selected_option     char(1) check (selected_option in ('A', 'B', 'C', 'D')),
    is_attempted        boolean not null default false,
    is_correct          boolean,
    time_spent_seconds  integer,
    answered_at         timestamptz not null default now(),
    unique (session_id, question_id)
);

create index if not exists idx_exam_answers_session on exam_answers(session_id);

-- ---------------------------------------------------------------------
-- exam_events — proctoring warning log (already used by the existing
-- proctoring.controller.js / POST /api/exam/proctoring/event route).
-- ---------------------------------------------------------------------
create table if not exists exam_events (
    id              uuid primary key default gen_random_uuid(),
    session_id      uuid not null references exam_sessions(id) on delete cascade,
    event_type      text not null,
    event_message   text,
    warning_number  integer,
    created_at      timestamptz not null default now()
);

create index if not exists idx_exam_events_session on exam_events(session_id);

-- =====================================================================
-- Row Level Security
--
-- This app does not use Supabase Auth for students (login is a custom
-- Registration ID + Hall Ticket Number check against the Registration
-- Supabase, issuing our own JWT — see
-- backend/src/middleware/studentAuth.js). The browser never talks to
-- Supabase directly: every request goes through the Express backend,
-- which uses the service_role key and therefore bypasses RLS by design.
-- Per-student authorization (a student may only read/write their own
-- session/answers) is enforced in that backend layer by checking the
-- JWT's candidate id against exam_sessions.candidate_id.
--
-- RLS is still enabled here as defense in depth: it guarantees that if
-- the anon/public key were ever used directly against this project
-- (misconfiguration, a leaked key, a future client-side integration),
-- it can read or write nothing on these tables — there are no
-- permissive policies below, so access defaults to fully denied for
-- every role except service_role.
-- =====================================================================

alter table exam_candidates enable row level security;
alter table exams enable row level security;
alter table subjects enable row level security;
alter table questions enable row level security;
alter table exam_sessions enable row level security;
alter table exam_answers enable row level security;
alter table exam_events enable row level security;

-- =====================================================================
-- Seed: one exam + 4 subjects + 60 questions (Mathematics -> Science ->
-- Reasoning -> English, 15 each), migrated from the frontend's previous
-- hardcoded src/data/questions.js so no question content is lost.
-- =====================================================================

insert into exams (exam_code, exam_name, seconds_per_question)
values ('GTST-2026', 'Global Talent Scholarship Test Plus · South India Level', 60)
on conflict (exam_code) do nothing;

insert into subjects (exam_id, subject_key, subject_name, display_order)
select id, s.subject_key, s.subject_name, s.display_order
from exams, (values
  ('maths', 'Mathematics', 1),
  ('science', 'Science', 2),
  ('reasoning', 'Reasoning', 3),
  ('english', 'English', 4)
) as s(subject_key, subject_name, display_order)
where exams.exam_code = 'GTST-2026'
on conflict (exam_id, subject_key) do nothing;

insert into questions (subject_id, question_number, question_text, passage, option_a, option_b, option_c, option_d, correct_option, marks)
select subjects.id, q.question_number, q.question_text, q.passage, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, 1
from subjects join exams on subjects.exam_id = exams.id, (values
  ('maths', 1, '248 + 376 − 129 = ?', NULL, '495', '486', '512', '473', 'A'),
  ('maths', 2, '3/4 + 1/8 = ?', NULL, '4/12', '7/8', '5/8', '1', 'B'),
  ('maths', 3, 'What is 15% of 240?', NULL, '24', '30', '36', '40', 'C'),
  ('maths', 4, 'Simplify the ratio 24:36.', NULL, '3:4', '4:6', '2:3', '1:2', 'C'),
  ('maths', 5, 'A rectangle has length 12 cm and breadth 7 cm. Find its perimeter.', NULL, '19 cm', '38 cm', '84 cm', '42 cm', 'B'),
  ('maths', 6, 'Solve for x: 3x + 7 = 22', NULL, 'x = 3', 'x = 5', 'x = 7', 'x = 15', 'B'),
  ('maths', 7, 'Which of the following is a prime number?', NULL, '21', '27', '29', '33', 'C'),
  ('maths', 8, 'A shopkeeper bought a pen for ₹40 and sold it for ₹50. Find the profit percentage.', NULL, '10%', '20%', '25%', '50%', 'C'),
  ('maths', 9, 'Find the area of a triangle with base 10 cm and height 6 cm.', NULL, '16 cm²', '30 cm²', '60 cm²', '32 cm²', 'B'),
  ('maths', 10, 'Which fraction is the largest?', NULL, '2/5', '3/7', '1/2', '4/9', 'C'),
  ('maths', 11, 'If 2(x − 3) = 10, find x.', NULL, '5', '6', '8', '11', 'C'),
  ('maths', 12, 'Divide ₹360 between A and B in the ratio 4:5. What is B''s share?', NULL, '₹160', '₹180', '₹200', '₹220', 'C'),
  ('maths', 13, 'Find the LCM of 12 and 18.', NULL, '24', '36', '72', '6', 'B'),
  ('maths', 14, 'What is the place value of 7 in 47,326?', NULL, '7', '70', '700', '7000', 'D'),
  ('maths', 15, 'A train travels 300 km in 5 hours. What is its average speed?', NULL, '50 km/h', '55 km/h', '60 km/h', '65 km/h', 'C'),
  ('science', 1, 'Which of these is a unit of force?', NULL, 'Joule', 'Newton', 'Watt', 'Pascal', 'B'),
  ('science', 2, 'What is the SI unit of length?', NULL, 'Kilogram', 'Metre', 'Second', 'Litre', 'B'),
  ('science', 3, 'What is the chemical symbol for Sodium?', NULL, 'Na', 'So', 'Sd', 'S', 'A'),
  ('science', 4, 'Which gas do plants absorb from the atmosphere for photosynthesis?', NULL, 'Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen', 'C'),
  ('science', 5, 'Which part of the plant is mainly responsible for photosynthesis?', NULL, 'Roots', 'Stem', 'Leaves', 'Flower', 'C'),
  ('science', 6, 'The human heart has how many chambers?', NULL, '2', '3', '4', '5', 'C'),
  ('science', 7, 'Which organ in the human body purifies blood?', NULL, 'Liver', 'Kidney', 'Lungs', 'Stomach', 'B'),
  ('science', 8, 'Which of these is NOT a natural source of light?', NULL, 'Sun', 'Moon', 'Stars', 'Fireflies', 'B'),
  ('science', 9, 'Which layer of the atmosphere protects Earth from harmful UV rays?', NULL, 'Troposphere', 'Ozone layer', 'Stratosphere floor', 'Ionosphere', 'B'),
  ('science', 10, 'Which of these is an example of a physical change?', NULL, 'Burning paper', 'Rusting iron', 'Melting ice', 'Cooking food', 'C'),
  ('science', 11, 'Sound travels fastest through which medium?', NULL, 'Air', 'Water', 'Vacuum', 'Steel', 'D'),
  ('science', 12, 'Which of these is a renewable source of energy?', NULL, 'Coal', 'Petroleum', 'Solar energy', 'Natural gas', 'C'),
  ('science', 13, 'Photosynthesis releases which gas as a byproduct?', NULL, 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen', 'B'),
  ('science', 14, 'Which force pulls objects toward the Earth?', NULL, 'Friction', 'Magnetism', 'Gravity', 'Tension', 'C'),
  ('science', 15, 'Which acid is found in lemon?', NULL, 'Acetic acid', 'Citric acid', 'Lactic acid', 'Sulphuric acid', 'B'),
  ('reasoning', 1, 'Find the next number in the series: 2, 4, 8, 16, ?', NULL, '20', '24', '32', '30', 'C'),
  ('reasoning', 2, 'If CAT is coded as DBU, how is DOG coded?', NULL, 'EPH', 'EPI', 'FPH', 'EOH', 'A'),
  ('reasoning', 3, 'Doctor is to Hospital as Teacher is to ?', NULL, 'Classroom', 'School', 'Book', 'Student', 'B'),
  ('reasoning', 4, 'Find the missing number: 5, 10, 15, ?, 25', NULL, '18', '20', '22', '24', 'B'),
  ('reasoning', 5, 'Which one does not belong to the group?', NULL, 'Apple', 'Banana', 'Carrot', 'Mango', 'C'),
  ('reasoning', 6, '''All birds can fly. A sparrow is a bird. Therefore, a sparrow can fly.'' This is an example of:', NULL, 'Deductive reasoning', 'Inductive reasoning', 'False logic', 'Random guess', 'A'),
  ('reasoning', 7, 'Find the next term: 1, 4, 9, 16, ?', NULL, '20', '23', '25', '28', 'C'),
  ('reasoning', 8, 'If ''GO'' is coded as ''7 15'' (based on letter position in the alphabet), how is ''SO'' coded?', NULL, '19 15', '20 15', '18 15', '19 14', 'A'),
  ('reasoning', 9, 'Pen is to Write as Knife is to ?', NULL, 'Sharp', 'Cut', 'Kitchen', 'Blade', 'B'),
  ('reasoning', 10, 'Complete the pattern: Circle, Square, Circle, Square, ?', NULL, 'Triangle', 'Square', 'Circle', 'Pentagon', 'C'),
  ('reasoning', 11, 'Which number does not belong: 9, 16, 25, 30?', NULL, '9', '16', '25', '30', 'D'),
  ('reasoning', 12, 'If today is Wednesday, what day will it be after 10 days?', NULL, 'Friday', 'Saturday', 'Sunday', 'Monday', 'B'),
  ('reasoning', 13, 'Find the next number: 3, 6, 12, 24, ?', NULL, '30', '36', '48', '42', 'C'),
  ('reasoning', 14, 'If ''BOOK'' is coded as ''CPPL'', how is ''PEN'' coded?', NULL, 'QFO', 'QFN', 'QGO', 'PFO', 'A'),
  ('reasoning', 15, 'Fish is to Water as Bird is to ?', NULL, 'Nest', 'Sky', 'Tree', 'Feather', 'B'),
  ('english', 1, 'By the time we reached the station, the train ___ already left.', NULL, 'has', 'had', 'have', 'having', 'B'),
  ('english', 2, 'Choose the word closest in meaning to ''Enormous''.', NULL, 'Tiny', 'Huge', 'Narrow', 'Quiet', 'B'),
  ('english', 3, 'Choose the word opposite in meaning to ''Ancient''.', NULL, 'Modern', 'Old', 'Ruined', 'Historic', 'A'),
  ('english', 4, 'Which sentence is correctly punctuated?', NULL, '"Where are you going," she asked.', '"Where are you going?" she asked.', 'Where are you going she asked?', '"Where are you going" she asked?', 'B'),
  ('english', 5, 'Choose the correctly formed sentence.', NULL, 'School Ravi to walks every day.', 'Ravi walks to school every day.', 'Walks Ravi school to every day.', 'Every day school walks Ravi to.', 'B'),
  ('english', 6, 'Choose the correct article: ''___ European country I visited was beautiful.''', NULL, 'A', 'An', 'The', 'No article', 'C'),
  ('english', 7, 'The word ''Frugal'' most nearly means:', NULL, 'Wasteful', 'Thrifty', 'Generous', 'Careless', 'B'),
  ('english', 8, 'Bees play a vital role in pollinating flowering plants, which produce much of the food we eat. Without bees, many crops would fail. According to the passage, why are bees important?', 'Bees play a vital role in pollinating flowering plants, which produce much of the food we eat. Without bees, many crops would fail, threatening food supplies worldwide.', 'They produce honey for humans', 'They pollinate plants that produce food', 'They protect crops from insects', 'They live in large colonies', 'B'),
  ('english', 9, 'Choose the correctly spelled word.', NULL, 'Neccessary', 'Necessary', 'Neccesary', 'Necesary', 'B'),
  ('english', 10, 'Identify the adjective in: ''The tall boy quickly climbed the steep hill.''', NULL, 'quickly', 'climbed', 'steep', 'hill', 'C'),
  ('english', 11, 'Choose the word that means ''afraid''.', NULL, 'Timid', 'Bold', 'Joyful', 'Calm', 'A'),
  ('english', 12, 'Choose the correct plural form of ''Child''.', NULL, 'Childs', 'Children', 'Childes', 'Childrens', 'B'),
  ('english', 13, 'Neither the teacher nor the students ___ ready for the test.', NULL, 'was', 'were', 'is', 'be', 'B'),
  ('english', 14, 'Which pair of words are antonyms?', NULL, 'Happy - Joyful', 'Rise - Fall', 'Big - Huge', 'Fast - Quick', 'B'),
  ('english', 15, 'Choose the sentence with correct subject-verb agreement.', NULL, 'The list of items are on the table.', 'The list of items is on the table.', 'The list of item is on table.', 'The lists of items is on the table.', 'B')
) as q(subject_key, question_number, question_text, passage, option_a, option_b, option_c, option_d, correct_option)
where exams.exam_code = 'GTST-2026' and subjects.subject_key = q.subject_key
on conflict (subject_id, question_number) do nothing;
