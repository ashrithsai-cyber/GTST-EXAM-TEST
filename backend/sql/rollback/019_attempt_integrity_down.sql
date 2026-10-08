-- ROLLBACK for 019_attempt_integrity.sql ONLY. Not a migration.
--
-- Usually unnecessary: 019 is additive and the previous backend keeps
-- working with it applied. Run this only if 019 itself must be removed,
-- and only AFTER the backend has been rolled back to a version that does
-- not call start_exam_attempt / block_exam_attempt /
-- admin_release_student_login_session (the current backend requires them).
-- No table rows are modified or deleted.
begin;

drop trigger if exists exam_sessions_status_guard on exam_sessions;
drop function if exists guard_exam_session_status();
drop function if exists block_exam_attempt(uuid, uuid, uuid, integer);
drop function if exists start_exam_attempt(uuid, uuid, uuid, uuid, integer);
drop function if exists admin_release_student_login_session(uuid);
alter table exam_answers drop constraint if exists exam_answers_attempt_question_fkey;
alter table exam_sessions drop constraint if exists exam_sessions_submitted_at_required;

commit;
