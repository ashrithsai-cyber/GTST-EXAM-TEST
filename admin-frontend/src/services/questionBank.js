// Shared data-adapter for exam/class/subject/question management, used
// by src/newadmin/pages/ExamsPage.tsx (exam + class + subject structure)
// and src/newadmin/pages/QuestionsPage.tsx (the filterable question bank
// per class/subject). Both reuse the same generic exams/classes/subjects/
// questions CRUD; this module maps that generic (exam_code/class_name/
// subject_key/question_number-shaped) backend contract to the camelCase
// form shape the admin UI components work with, and slots reasonable
// defaults (subjectKey, displayOrder, questionNumber) into fields the UI
// never collects itself.
import {
  listExams,
  createExam,
  updateExam,
  updateExamStatus,
  updateResultsPublication,
  deleteExam,
  listClasses,
  createClass,
  deleteClass,
  listSubjects,
  createSubject,
  deleteSubject,
  listQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  downloadQuestionTemplate as apiDownloadQuestionTemplate,
  importQuestionsExcel,
} from "./adminApi";

const slugify = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "item";

export function mapExam(exam) {
  return {
    id: exam.id,
    name: exam.exam_name,
    examCode: exam.exam_code,
    status: exam.status,
    secondsPerQuestion: exam.seconds_per_question,
    examDate: exam.exam_date || "",
    // Exam Timing (backend/sql/012_exam_timing.sql) — examStartAt/
    // examEndAt are full ISO instants (UTC), durationMinutes the admin-
    // set total exam length. timingStatus is computed server-side by
    // the exact same computeTimingStatus() the student-facing
    // waiting-room gate enforces against, so this badge can never
    // disagree with what's actually enforced. null/'UNSCHEDULED' means
    // this exam predates the feature or was never scheduled — today's
    // unchanged, un-gated behavior.
    examStartAt: exam.exam_start_at || null,
    examEndAt: exam.exam_end_at || null,
    durationMinutes: Number.isFinite(exam.duration_minutes) ? exam.duration_minutes : null,
    timingStatus: exam.timing_status || "UNSCHEDULED",
    resultsPublished: Boolean(exam.results_published),
  };
}

export function mapClass(cls) {
  return {
    id: cls.id,
    examId: cls.exam_id,
    name: cls.class_name,
    displayOrder: cls.display_order,
  };
}

export function mapSubject(subject) {
  return {
    id: subject.id,
    name: subject.subject_name,
    displayOrder: subject.display_order,
  };
}

export function mapQuestion(question) {
  return {
    id: question.id,
    question: question.question_text,
    passage: question.passage || "",
    optionA: question.option_a,
    optionB: question.option_b,
    optionC: question.option_c,
    optionD: question.option_d,
    correctAnswer: question.correct_option,
    marks: question.marks,
    questionNumber: question.question_number,
    // Admin-side organizational field only — not consulted by student
    // delivery. See backend/sql/006_question_status.sql.
    status: question.status || "ACTIVE",
  };
}

// Includes every exam, ACTIVE or not — an admin needs to see and manage
// (rename, reschedule, retime, deactivate) the exam that's actually live
// to students, not just the inactive ones. What's actually blocked is
// DELETING an active exam (enforced server-side in
// backend/src/controllers/admin.controller.js deleteExam) — editing/
// deactivating stays available.
export async function fetchExams() {
  const { exams } = await listExams();
  return exams.map(mapExam);
}

// New exams are created INACTIVE — activating one is a separate,
// explicit action (setExamStatus) that also deactivates every other
// exam server-side, so there is only ever one exam live to students.
export async function addExam(name) {
  const { exam } = await createExam({
    examCode: `EXAM-${slugify(name)}-${Date.now().toString(36)}`,
    examName: name,
    status: "INACTIVE",
  });
  return mapExam(exam);
}

// Full exam-configuration update (name, per-question timer, scheduled
// date, Exam Timing) — used by the Exams page "Edit Exam" modal.
// secondsPerQuestion, examDate, examStartAt and durationMinutes are only
// sent when actually provided, so a partial edit never clobbers a field
// the admin didn't touch.
export async function updateExamDetails(examId, { name, secondsPerQuestion, examDate, examStartAt, durationMinutes }) {
  const payload = {};
  if (name !== undefined) payload.examName = name;
  if (secondsPerQuestion !== undefined) payload.secondsPerQuestion = secondsPerQuestion;
  if (examDate !== undefined) payload.examDate = examDate;
  if (examStartAt !== undefined) payload.examStartAt = examStartAt;
  if (durationMinutes !== undefined) payload.durationMinutes = durationMinutes;
  const { exam } = await updateExam(examId, payload);
  return mapExam(exam);
}

// "Delete an exam timing" — unschedules the exam back to today's
// un-gated behavior (no waiting room, no overall deadline) without
// touching anything else about it. Distinct from removeExam, which
// deletes the whole exam and everything under it.
export async function clearExamTiming(examId) {
  const { exam } = await updateExam(examId, { examStartAt: null, durationMinutes: null });
  return mapExam(exam);
}

export async function setExamStatus(examId, status) {
  const { exam } = await updateExamStatus(examId, status);
  return mapExam(exam);
}

// Publishes (or hides again) students' own results for this exam.
export async function setResultsPublished(examId, published) {
  await updateResultsPublication(examId, published);
}

export async function removeExam(examId) {
  await deleteExam(examId);
}

// Preloads the full exam -> class -> subject -> question tree in one go
// (all class/subject/question fetches run in parallel per level) so the
// Exams list can show class/subject/question counts, and so drilling
// into a class or subject afterwards is instant — reading from this
// already-loaded tree rather than firing new requests. There is no
// lightweight counts-only endpoint on the backend, so this is the N+1
// cost of a fully generic exam/class/subject/question API; acceptable
// at this app's scale (a handful of exams/classes, a few subjects each).
export async function fetchExamsWithTree() {
  const exams = await fetchExams();
  return Promise.all(
    exams.map(async (exam) => {
      const classes = await fetchClasses(exam.id);
      const classesWithSubjects = await Promise.all(
        classes.map(async (cls) => {
          const subjects = await fetchSubjects(cls.id);
          const subjectsWithQuestions = await Promise.all(
            subjects.map(async (subject) => ({
              ...subject,
              questions: await fetchQuestions(subject.id),
            }))
          );
          return { ...cls, subjects: subjectsWithQuestions };
        })
      );
      return { ...exam, classes: classesWithSubjects };
    })
  );
}

export async function fetchClasses(examId) {
  const { classes } = await listClasses(examId);
  return classes.sort((a, b) => a.display_order - b.display_order).map(mapClass);
}

export async function addClass(examId, name, existingCount) {
  const { class: cls } = await createClass(examId, {
    className: name,
    displayOrder: existingCount + 1,
  });
  return mapClass(cls);
}

export async function removeClass(classId) {
  await deleteClass(classId);
}

export async function fetchSubjects(classId) {
  const { subjects } = await listSubjects(classId);
  return subjects.sort((a, b) => a.display_order - b.display_order).map(mapSubject);
}

export async function addSubject(classId, name, existingCount) {
  const { subject } = await createSubject(classId, {
    subjectKey: slugify(name),
    subjectName: name,
    displayOrder: existingCount + 1,
  });
  return mapSubject(subject);
}

export async function removeSubject(subjectId) {
  await deleteSubject(subjectId);
}

// question_number only has to be unique per subject, not contiguous —
// after a deletion, `questions.length + 1` can collide with a number
// that still exists (e.g. delete #2 out of [#1,#2,#3], length becomes 2,
// but #3 is still taken). Basing it on the highest number in use avoids
// that race against the unique(subject_id, question_number) constraint.
export function nextQuestionNumber(questions) {
  return questions.reduce((max, q) => Math.max(max, q.questionNumber || 0), 0) + 1;
}

export async function fetchQuestions(subjectId) {
  const { questions } = await listQuestions(subjectId);
  return questions.sort((a, b) => a.question_number - b.question_number).map(mapQuestion);
}

function toQuestionPayload(form) {
  return {
    questionText: form.question.trim(),
    passage: form.passage || null,
    optionA: form.optionA.trim(),
    optionB: form.optionB.trim(),
    optionC: form.optionC.trim(),
    optionD: form.optionD.trim(),
    correctOption: form.correctAnswer,
    marks: Number(form.marks) || 1,
    status: form.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
  };
}

export async function addQuestion(subjectId, form, nextQuestionNumber) {
  const { question } = await createQuestion(subjectId, {
    questionNumber: nextQuestionNumber,
    ...toQuestionPayload(form),
  });
  return mapQuestion(question);
}

export async function editQuestion(questionId, form) {
  const { question } = await updateQuestion(questionId, toQuestionPayload(form));
  return mapQuestion(question);
}

export async function removeQuestion(questionId) {
  await deleteQuestion(questionId);
}

export const downloadQuestionTemplate = () => apiDownloadQuestionTemplate();

// Returns { summary: { totalRows, imported, failed }, results: [...] }
// straight from the backend (backend/src/controllers/questionImport.controller.js)
// — every row's pass/fail, untouched, so the page can render it without
// re-deriving anything.
export async function uploadQuestionsExcel(subjectId, file) {
  return importQuestionsExcel(subjectId, file);
}
