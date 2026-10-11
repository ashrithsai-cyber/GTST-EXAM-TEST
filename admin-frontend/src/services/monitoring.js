// Shared shaping logic for Live Monitoring and Violations — both need
// "which student does this session/event belong to" plus per-event-type
// counts, computed from the same two endpoints (sessions + proctoring
// events). Centralized here so the two pages stay consistent.
import {
  listCandidates, listSessions, listProctoringEvents, summarizeMonitoringEvents,
} from "./adminApi";

// exam_events.event_type only ever contains these values (see
// backend/src/controllers/proctoring.controller.js ALLOWED_EVENTS).
// "Location Events"/"Remote Desktop" have no backing event type at all —
// nothing in this system detects either — so those two counters always
// read 0 honestly, not as a bug. NETWORK_DISCONNECT does have a real
// event type (added alongside the student-side network-detection work)
// and is counted below.
const CAMERA_EVENT_TYPES = new Set(["MULTIPLE_FACE", "NO_FACE", "CAMERA_DISABLED"]);
// A pre-exam student (Logged In / System Check / Rules) is only listed
// while their presence is fresh — the System Check and Rules pages ping
// every 10s. Without this, anyone who closed the tab would stay "online"
// on Live Students forever.
const PRESENCE_STALE_AFTER_MS = 2 * 60 * 1000;
// is_likely_disconnected comes straight from the backend (admin.controller.js
// listSessions) — a real, honestly-labeled proxy from last_activity_at
// staleness, not a true heartbeat. See that file's isLikelyDisconnected().
export function deriveStatus(session) {
  if (session.status === "NOT_STARTED" && !session.presence_stage) return "notStarted";
  if (session.status === "SUBMITTED") return "completed";
  if (session.status === "BLOCKED") return "critical";
  if (session.is_likely_disconnected) return "disconnected";
  if ((session.proctoring_warning_count || 0) > 0) return "warning";
  return "active";
}

const PRESENCE_LABELS = {
  LOGGED_IN: "Logged In",
  SYSTEM_CHECK: "System Check",
  RULES: "Watching Rules/Video",
  IN_EXAM: "In Exam",
  COMPLETED: "Completed",
};

// Human label for the table/drawer — prefers the real session-derived
// status (it's authoritative for anyone already in exam_sessions), and
// only falls back to the presence stage label for the sliver of cases
// where a session exists but hasn't been marked IN_EXAM by presence yet.
export function statusLabel(session) {
  const status = deriveStatus(session);
  if (status === "notStarted") return "Not Started";
  if (status === "completed") return "Completed";
  if (status === "critical") return "Blocked";
  if (status === "disconnected") return "Disconnected";
  if (status === "warning") return "In Exam (Warning)";
  return PRESENCE_LABELS[session.presence_stage] || "In Exam";
}

export function progressForSession(session) {
  const snapshot = session.attempt_progress;
  return {
    attempted: snapshot?.attempted || 0,
    total: snapshot?.total || 0,
    currentSubject: snapshot?.current_subject || "—",
    available: Boolean(snapshot && snapshot.total > 0),
  };
}

export function countEventsBySession(events) {
  const bySession = new Map();
  for (const event of events) {
    if (!bySession.has(event.session_id)) {
      bySession.set(event.session_id, {
        cameraChanges: 0,
        tabSwitches: 0,
        fullscreenExits: 0,
        microphoneLosses: 0,
        rightClicks: 0,
        networkDrops: 0,
        locationEvents: 0,
        remoteDesktopEvents: 0,
      });
    }
    const counters = bySession.get(event.session_id);
    if (CAMERA_EVENT_TYPES.has(event.event_type)) counters.cameraChanges += 1;
    if (event.event_type === "TAB_SWITCH") counters.tabSwitches += 1;
    if (event.event_type === "FULLSCREEN_EXIT") counters.fullscreenExits += 1;
    if (event.event_type === "MICROPHONE_DISABLED") counters.microphoneLosses += 1;
    if (event.event_type === "RIGHT_CLICK") counters.rightClicks += 1;
    if (event.event_type === "NETWORK_DISCONNECT") counters.networkDrops += 1;
  }
  return bySession;
}

function countSummariesBySession(summaries) {
  const bySession = new Map();
  for (const summary of summaries) {
    const counts = summary.event_counts || {};
    bySession.set(summary.session_id, {
      violationCount: summary.violation_count ?? 0,
      cameraChanges: Array.from(CAMERA_EVENT_TYPES).reduce((total, type) => total + (counts[type] || 0), 0),
      tabSwitches: counts.TAB_SWITCH || 0,
      fullscreenExits: counts.FULLSCREEN_EXIT || 0,
      microphoneLosses: counts.MICROPHONE_DISABLED || 0,
      rightClicks: counts.RIGHT_CLICK || 0,
      networkDrops: counts.NETWORK_DISCONNECT || 0,
      locationEvents: 0,
      remoteDesktopEvents: 0,
    });
  }
  return bySession;
}

export const VIOLATION_LABELS = {
  MULTIPLE_FACE: "Multiple Faces Detected",
  NO_FACE: "No Face Detected",
  CAMERA_DISABLED: "Camera Blocked",
  MICROPHONE_DISABLED: "Microphone Muted / Disabled",
  TAB_SWITCH: "Tab Switch",
  WINDOW_BLUR: "Window Lost Focus",
  FULLSCREEN_EXIT: "Fullscreen Exit",
  RIGHT_CLICK: "Right Click",
  COPY_PASTE: "Copy / Paste Attempt",
  NETWORK_DISCONNECT: "Network Disconnected",
  NETWORK_RECONNECT: "Network Reconnected",
  EXAM_LEFT: "Left Exam Page",
};

// Network events are connectivity telemetry, not rule violations (the
// backend never counts them as warnings), so the Violations page leaves
// them out. Everything else in exam_events is a violation.
const INFORMATIONAL_EVENT_TYPES = new Set(["NETWORK_DISCONNECT", "NETWORK_RECONNECT"]);
export const VIOLATION_TYPE_OPTIONS = Object.keys(VIOLATION_LABELS)
  .filter((type) => !INFORMATIONAL_EVENT_TYPES.has(type))
  .map((type) => ({ value: type, label: VIOLATION_LABELS[type] }));

// Groups raw exam_events rows (one per occurrence) into one record per
// student attempt (exam_sessions row): student and exam details, the
// total violation count, a per-rule count, and the full event timeline.
export function buildStudentViolations(events) {
  const bySession = new Map();
  for (const event of events) {
    if (INFORMATIONAL_EVENT_TYPES.has(event.event_type)) continue;
    if (!bySession.has(event.session_id)) {
      const session = event.exam_sessions || {};
      const candidate = session.exam_candidates || {};
      bySession.set(event.session_id, {
        id: event.session_id,
        sessionId: event.session_id,
        candidateId: session.candidate_id || null,
        studentName: candidate.full_name || "Unknown",
        registrationId: candidate.registration_id || "—",
        className: candidate.student_class ? `Class ${candidate.student_class}` : "Unspecified",
        examId: session.exam_id || null,
        examName: session.exams?.exam_name || "Unknown exam",
        attemptStatus: session.status || null,
        total: 0,
        countsByType: {},
        lastAt: event.created_at,
        events: [],
        unreviewedIds: [],
      });
    }
    const record = bySession.get(event.session_id);
    record.total += 1;
    record.countsByType[event.event_type] = (record.countsByType[event.event_type] || 0) + 1;
    record.events.push({
      id: event.id,
      type: event.event_type,
      label: VIOLATION_LABELS[event.event_type] || event.event_type,
      message: event.event_message || "",
      reviewed: Boolean(event.reviewed),
      createdAt: event.created_at,
    });
    if (!event.reviewed) record.unreviewedIds.push(event.id);
    if (new Date(event.created_at) > new Date(record.lastAt)) record.lastAt = event.created_at;
  }
  return Array.from(bySession.values())
    .map((record) => ({
      ...record,
      events: record.events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      rules: Object.entries(record.countsByType)
        .map(([type, count]) => ({ type, label: VIOLATION_LABELS[type] || type, count }))
        .sort((a, b) => b.count - a.count),
      reviewStatus: record.unreviewedIds.length ? "unreviewed" : "reviewed",
    }))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}

export async function fetchMonitoringData() {
  const fetchAll = async (fetchPage, initialParams, collectionKey) => {
    const first = await fetchPage({ ...initialParams, page: 1 });
    const pages = Math.ceil((first.total || 0) / (first.limit || 100));
    if (pages <= 1) return first;
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) =>
      fetchPage({ ...initialParams, page: index + 2 })
    ));
    const key = collectionKey || (first.sessions ? "sessions" : "events");
    return { ...first, [key]: [first[key] || [], ...rest.map((page) => page[key] || [])].flat() };
  };

  const sessionsRes = await fetchAll(
    (params) => listSessions(params),
    { status: "IN_PROGRESS,BLOCKED,SUBMITTED" },
    "sessions"
  );

  const candidatesRes = await fetchAll((params) => listCandidates(params), {}, "candidates");
  const sessions = [...(sessionsRes.sessions || [])];
  const sessionCandidateIds = new Set(sessions.map((session) => session.candidate_id));
  const presenceStages = new Set(["LOGGED_IN", "SYSTEM_CHECK", "RULES", "IN_EXAM"]);

  for (const candidate of candidatesRes.candidates || []) {
    if (sessionCandidateIds.has(candidate.id) || !presenceStages.has(candidate.presence?.stage)) continue;
    if (Date.now() - new Date(candidate.presence.updated_at || 0).getTime() > PRESENCE_STALE_AFTER_MS) continue;
    const exam = candidate.active_exam;
    sessions.push({
      id: `presence-${candidate.id}`,
      candidate_id: candidate.id,
      exam_id: exam?.id || null,
      class_id: candidate.active_class_id || null,
      status: "NOT_STARTED",
      current_subject_index: 0,
      current_question_index: 0,
      question_started_at: null,
      started_at: null,
      submitted_at: null,
      last_activity_at: candidate.presence.updated_at,
      total_score: null,
      max_score: null,
      proctoring_warning_count: 0,
      exams: exam ? { exam_name: exam.exam_name, seconds_per_question: exam.seconds_per_question } : null,
      exam_candidates: candidate,
      presence_stage: candidate.presence.stage,
      presence_updated_at: candidate.presence.updated_at,
      is_likely_disconnected: false,
    });
  }

  const sessionIds = sessions.filter((session) => !session.id.startsWith("presence-")).map((session) => session.id);
  const summaryRequests = [];
  for (let index = 0; index < sessionIds.length; index += 250) {
    summaryRequests.push(summarizeMonitoringEvents(sessionIds.slice(index, index + 250)));
  }
  let monitoringWarning = sessionsRes.monitoringWarning || null;
  const summaryResponses = await Promise.all(summaryRequests.map(async request => {
    try {
      return await request;
    } catch (error) {
      if (error.data?.code !== "MONITORING_MIGRATION_REQUIRED") throw error;
      monitoringWarning = error.message;
      return { summaries: [] };
    }
  }));
  const eventCounts = countSummariesBySession(summaryResponses.flatMap((response) => response.summaries || []));

  return { sessions, examsMap: new Map(), eventCounts, monitoringWarning };
}

/** @param {string | null} [createdAfter] */
export async function fetchStudentViolations(createdAfter = null) {
  const filters = createdAfter ? { createdAfter } : {};
  const first = await listProctoringEvents({ ...filters, page: 1 });
  const pages = Math.ceil((first.total || 0) / (first.limit || 100));
  const rest = [];
  for (let page = 2; page <= pages; page += 1) {
    rest.push(await listProctoringEvents({ ...filters, page }));
  }
  const events = [first.events || [], ...rest.map((page) => page.events || [])].flat();
  return buildStudentViolations(events);
}
