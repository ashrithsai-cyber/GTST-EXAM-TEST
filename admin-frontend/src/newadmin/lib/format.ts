import type { SessionDisplayStatus, ExamStatus, ExamTimingStatus, QuestionStatus, AdminRole } from './types';

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let str: string;
  if (mins < 1) str = 'just now';
  else if (mins < 60) str = `${mins}m ago`;
  else if (hours < 24) str = `${hours}h ago`;
  else str = `${days}d ago`;
  if (future) str = str.replace('ago', 'from now');
  return str;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

// Mirrors admin-frontend/src/services/monitoring.js's deriveStatus()
// output values exactly — that function is the single source of truth
// for what "status" a session is in; this only supplies display labels.
export const sessionDisplayStatusMeta: Record<SessionDisplayStatus, { label: string; tone: Tone }> = {
  notStarted: { label: 'Not Started', tone: 'neutral' },
  active: { label: 'In Exam', tone: 'brand' },
  warning: { label: 'In Exam (Warning)', tone: 'warning' },
  disconnected: { label: 'Disconnected', tone: 'danger' },
  critical: { label: 'Blocked', tone: 'danger' },
  completed: { label: 'Completed', tone: 'success' },
};

export const presenceStageMeta: Record<string, { label: string; tone: Tone }> = {
  LOGGED_IN: { label: 'Logged In', tone: 'neutral' },
  SYSTEM_CHECK: { label: 'System Check', tone: 'warning' },
  RULES: { label: 'Watching Rules/Video', tone: 'accent' },
  IN_EXAM: { label: 'In Exam', tone: 'brand' },
  COMPLETED: { label: 'Completed', tone: 'success' },
};

export const examStatusMeta: Record<ExamStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'brand' },
  INACTIVE: { label: 'Inactive', tone: 'neutral' },
};

// Exam Timing status badge (Scheduled/Live/Completed) — see
// ExamTimingStatus in types.ts. UNSCHEDULED is intentionally not badged
// on the Exams page (an exam with no timing configured just shows
// nothing extra) but is included here for completeness.
export const timingStatusMeta: Record<ExamTimingStatus, { label: string; tone: Tone }> = {
  UNSCHEDULED: { label: 'Not Scheduled', tone: 'neutral' },
  SCHEDULED: { label: 'Scheduled', tone: 'warning' },
  LIVE: { label: 'Live', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
};

// ===================================================================
// IST (Asia/Kolkata) helpers for the Exam Timing section — India has a
// single fixed UTC+5:30 offset year-round (no daylight saving), so this
// is a plain, always-correct arithmetic conversion rather than needing
// full Intl timezone-database support.
// ===================================================================

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Converts an admin-entered IST wall-clock date ("YYYY-MM-DD") + time
// ("HH:mm") into an absolute UTC ISO instant — what the backend actually
// stores and compares against the server clock. Sending an unambiguous
// instant (rather than a bare local-looking string) means the backend
// needs no timezone-specific logic of its own; the IST framing lives
// entirely in this admin UI layer, per one place responsible for it.
export function istToUtcIso(dateStr: string, timeStr: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

// Inverse of istToUtcIso — splits a stored UTC instant back into IST
// wall-clock date/time parts, for pre-filling the Edit Timing form's
// <input type="date"> / <input type="time"> values.
export function utcIsoToIstParts(iso: string): { date: string; time: string } {
  const ms = new Date(iso).getTime() + IST_OFFSET_MS;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

// Display helper: "10 Sep 2026, 10:00 AM IST".
export function formatIst(iso: string | null): string {
  if (!iso) return '—';
  const formatted = new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatted} IST`;
}

export const questionStatusMeta: Record<QuestionStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Published', tone: 'success' },
  INACTIVE: { label: 'Draft', tone: 'neutral' },
};

export const adminRoleMeta: Record<AdminRole, { label: string; tone: Tone }> = {
  admin: { label: 'Admin', tone: 'brand' },
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
