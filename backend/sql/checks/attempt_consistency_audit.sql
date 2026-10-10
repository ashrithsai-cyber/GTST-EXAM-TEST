-- READ-ONLY consistency audit for the exam database. Safe to run at any
-- time (no writes). Not a migration: run it in the SQL editor before and
-- after deploying 019_attempt_integrity.sql. Every check should return 0.
-- legacy_* checks may be non-zero for attempts created before 017; they
-- are reported separately so they are not mistaken for new corruption.
select check_name, violations from (
    select 1 as ord, 'duplicate_attempts_per_candidate_exam' as check_name, count(*) as violations
    from (select candidate_id, exam_id from exam_sessions group by candidate_id, exam_id having count(*) > 1) d
    union all
    select 2, 'multiple_in_progress_attempts_per_candidate', count(*)
    from (select candidate_id from exam_sessions where status = 'IN_PROGRESS' group by candidate_id having count(*) > 1) d
    union all
    select 3, 'answers_outside_attempt_sequence', count(*)
    from exam_answers a join exam_sessions s on s.id = a.session_id
    where s.sequence_initialized_at is not null and not exists (
        select 1 from exam_attempt_questions q where q.session_id = a.session_id and q.question_id = a.question_id)
    union all
    select 4, 'legacy_answers_without_snapshot', count(*)
    from exam_answers a join exam_sessions s on s.id = a.session_id
    where s.sequence_initialized_at is null
    union all
    select 5, 'answer_subject_differs_from_snapshot', count(*)
    from exam_answers a join exam_attempt_questions q on q.session_id = a.session_id and q.question_id = a.question_id
    where a.subject_id <> q.subject_id
    union all
    select 6, 'answers_saved_after_submission', count(*)
    from exam_answers a join exam_sessions s on s.id = a.session_id
    where s.status = 'SUBMITTED' and a.answered_at > s.submitted_at
    union all
    select 7, 'submitted_without_submitted_at', count(*)
    from exam_sessions where status = 'SUBMITTED' and submitted_at is null
    union all
    select 8, 'running_with_submitted_at', count(*)
    from exam_sessions where status = 'IN_PROGRESS' and submitted_at is not null
    union all
    select 9, 'sequence_count_differs_from_total_questions', count(*)
    from exam_sessions s where s.sequence_initialized_at is not null
      and s.total_questions <> (select count(*) from exam_attempt_questions q where q.session_id = s.id)
    union all
    select 10, 'sequence_positions_not_contiguous', count(*)
    from (select session_id from exam_attempt_questions group by session_id
          having min(position) <> 0 or max(position) + 1 <> count(*)) d
    union all
    select 11, 'current_position_out_of_range', count(*)
    from exam_sessions where sequence_initialized_at is not null
      and (current_position < 0 or current_position > total_questions)
    union all
    select 12, 'running_attempt_without_sequence', count(*)
    from exam_sessions where status = 'IN_PROGRESS' and sequence_initialized_at is null
      and created_at < now() - interval '5 minutes'
    union all
    select 13, 'running_attempt_past_deadline', count(*)
    from exam_sessions where status = 'IN_PROGRESS' and deadline_at < now() - interval '2 minutes'
    union all
    select 14, 'attempt_class_not_in_attempt_exam', count(*)
    from exam_sessions s join classes c on c.id = s.class_id where c.exam_id <> s.exam_id
    union all
    select 15, 'submitted_candidate_presence_not_completed', count(*)
    from student_presence p where p.stage <> 'COMPLETED' and exists (
        select 1 from exam_sessions s join exams e on e.id = s.exam_id
        where s.candidate_id = p.candidate_id and s.status = 'SUBMITTED' and e.status = 'ACTIVE')
      and not exists (select 1 from exam_sessions s where s.candidate_id = p.candidate_id and s.status = 'IN_PROGRESS')
) checks order by ord;
