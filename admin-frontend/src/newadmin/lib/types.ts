// Types shaped to match the REAL backend/Exam-Supabase data this admin
// dashboard is wired to (see backend/src/controllers/admin.controller.js,
// mockVideo.controller.js, settings.controller.js) — not the original
// Bolt export's invented mock model. Every field here is either a direct
// rename of a real API field or a documented derived value; nothing is
// fabricated. See the plan's Part B/D for the gaps this intentionally
// does not paper over (per-device continuous status, video library,
// violation severity, moderator role, audit IP, exam duration/status).

export type ExamStatus = 'ACTIVE' | 'INACTIVE';

// Derived Exam Timing status (backend/src/controllers/_examShared.js's
// computeTimingStatus, mirrored by the admin API's withTimingStatus) —
// distinct from ExamStatus above, which is about which exam is served
// to students at all, not when it's scheduled to run. UNSCHEDULED means
// no exam_start_at is set (predates this feature, or never scheduled):
// no waiting room, no overall deadline, today's original behavior.
export type ExamTimingStatus = 'UNSCHEDULED' | 'SCHEDULED' | 'LIVE' | 'COMPLETED';

// Shaped to match admin-frontend/src/services/questionBank.js's
// mapQuestion() output exactly — that module (already hardened, used by
// the existing admin dashboard) is reused verbatim for all exam/subject/
// question CRUD rather than re-derived against raw API rows here.
export interface Question {
  id: string;
  question: string;
  passage: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: 'A' | 'B' | 'C' | 'D';
  marks: number;
  questionNumber: number;
  status: QuestionStatus;
}

export type QuestionStatus = 'ACTIVE' | 'INACTIVE';

// Shaped to match questionBank.js's mapSubject() output, extended with
// the loaded questions array (fetchExamsWithTree) or a derived count.
export interface Subject {
  id: string;
  name: string;
  displayOrder: number;
  questions: Question[];
}

// Shaped to match questionBank.js's mapClass() output, extended with the
// loaded subjects array (fetchExamsWithTree).
export interface Class {
  id: string;
  examId: string;
  name: string;
  displayOrder: number;
  subjects: Subject[];
}

// Shaped to match questionBank.js's mapExam() output, extended
// with derived-only fields (Part B.7/B.8) computed by the page, never
// invented.
export interface Exam {
  id: string;
  name: string;
  examCode: string;
  status: ExamStatus;
  secondsPerQuestion: number;
  examDate: string;
  // Exam Timing (backend/sql/012_exam_timing.sql) — the admin-scheduled
  // start instant + total exam duration that gate the student-facing
  // waiting room and overall exam-window deadline. null/'UNSCHEDULED'
  // means this exam has never been scheduled via the Exam Timing
  // section — see ExamsPage.tsx.
  examStartAt: string | null; // ISO instant (UTC)
  examEndAt: string | null; // derived: examStartAt + durationMinutes
  durationMinutes: number | null;
  timingStatus: ExamTimingStatus;
  // Whether students can see their own score for this exam
  // (backend/sql/014_preflight_results_hardening.sql).
  resultsPublished: boolean;
  classes: Class[];
  totalQuestions: number; // derived: sum of classes[].subjects[].questions.length
  studentsStarted: number; // derived: exam_sessions count for this exam (Part B.8)
  estDurationMinutes: number | null; // derived: totalQuestions * secondsPerQuestion / 60 (Part B.7)
}

export interface SafetyVideo {
  id: string;
  title: string;
  description: string | null;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

// The exam name + logo shown across the entire Student Exam Portal
// (header, footer, login page, exam-taking header) — see
// backend/src/controllers/branding.controller.js. A single global row,
// not tied to any specific exam in the Exams page.
export interface Branding {
  examName: string;
  logoUrl: string | null;
  updatedAt: string;
}

export type PresenceStage = 'LOGGED_IN' | 'SYSTEM_CHECK' | 'RULES' | 'IN_EXAM' | 'COMPLETED' | null;
export type SessionDbStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'BLOCKED' | 'NOT_STARTED';
// Derived display status — mirrors admin-frontend/src/services/monitoring.js's
// deriveStatus() exactly (reused, not reimplemented).
export type SessionDisplayStatus = 'active' | 'warning' | 'disconnected' | 'critical' | 'completed' | 'notStarted';

// Matches GET /api/admin/sessions's row shape exactly (see
// admin.controller.js listSessions / SESSION_BASE_FIELDS) — kept in raw
// snake_case/embed form deliberately, rather than force-renamed into a
// clean camelCase model, because the status/progress derivation
// (deriveStatus/statusLabel/progressForSession in
// admin-frontend/src/services/monitoring.js) is written against this
// exact shape and is reused as-is, not reimplemented, in the new pages.
export interface RawSession {
  id: string;
  candidate_id: string;
  exam_id: string | null;
  class_id: string | null;
  status: SessionDbStatus;
  current_subject_index: number | null;
  current_question_index: number | null;
  question_started_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  last_activity_at: string | null;
  total_score: number | null;
  max_score: number | null;
  proctoring_warning_count: number | null;
  exams: { exam_name: string; seconds_per_question: number } | null;
  exam_candidates: {
    registration_id: string;
    full_name: string;
    student_class: string | null;
    hall_ticket_number: string | null;
  } | null;
  presence_stage: PresenceStage;
  is_likely_disconnected: boolean;
}

// No stored severity column — this is a UI-side classification reusing
// the exact heuristic admin-frontend/src/services/monitoring.js already
// applies (maxWarningNumber >= 3 => critical), not new fabrication.
export type ViolationSeverity = 'warning' | 'critical';

// Shaped to match admin-frontend/src/services/monitoring.js's
// buildViolationRows() output exactly (reused as-is — see adapters.ts).
// That function groups raw exam_events without retaining exam_id, so
// there's deliberately no examName here rather than adding ad-hoc
// plumbing on top of an already-hardened helper for a nice-to-have column.
export interface Violation {
  id: string; // `${sessionId}-${eventType}`
  sessionId: string;
  studentName: string;
  registrationId: string;
  studentClass: string | null;
  type: string; // human label for event_type
  severity: ViolationSeverity;
  count: number;
  lastOccurredAt: string;
  reviewed: boolean;
  eventIds: string[];
}

export interface Result {
  id: string; // session id
  studentName: string;
  registrationId: string;
  studentClass: string | null;
  examId: string;
  submittedAt: string | null;
  score: number;
  maxScore: number;
  percentage: number;
}

// Single admin role — every authenticated admin can manage everything
// (see backend/src/controllers/admin.controller.js).
export type AdminRole = 'admin';

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuditLogEntry {
  id: string;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardStats {
  totalCandidates: number;
  totalExams: number;
  sessionsInProgress: number;
  sessionsSubmitted: number;
  sessionsBlocked: number;
  sessionsNotStarted: number;
  sessionsDisconnected: number;
  averageScorePercent: number | null;
  classBreakdown: { studentClass: string; present: number; ongoing: number; completed: number; alerts: number }[];
}

// Shaped to match settings.controller.js's getSettings/updateSettings
// response exactly. videoRequired and networkMonitoringEnabled are read by
// the student portal from the same row but have no admin UI yet; every
// other field is a toggle on the System Requirements page.
export interface ExamSettings {
  cameraRequired: boolean;
  photoCaptureEnabled: boolean;
  microphoneRequired: boolean;
  fullscreenRequired: boolean;
  faceDetectionEnabled: boolean;
  proctoringEnabled: boolean;
  videoRequired: boolean;
  networkMonitoringEnabled: boolean;
  tabSwitchMonitoringEnabled: boolean;
}

export interface CurrentAdmin {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}
