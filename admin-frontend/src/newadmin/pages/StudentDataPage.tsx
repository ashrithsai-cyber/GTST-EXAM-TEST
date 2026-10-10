import { useEffect, useMemo, useState } from 'react';
import { IdCard, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput, Select, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { Modal } from '../components/ui/Modal';
import { formatDateTime, presenceStageMeta, sessionDisplayStatusMeta } from '../lib/format';
import type { RawSession, SessionDisplayStatus } from '../lib/types';
// Status derivation reused verbatim from the existing admin dashboard's
// shared helper (same one Live Students/Dashboard already rely on) —
// not reimplemented here. Data comes straight from GET /api/admin/sessions
// (admin.controller.js listSessions), the same endpoint that already
// joins candidate + exam + presence info for every session record.
import { deriveStatus, statusLabel } from '../../services/monitoring';
import { listCandidates, getCandidateDeviceSession, releaseCandidateDeviceSession } from '../../services/adminApi';
import { AttemptAnswerSheet } from '../components/AttemptAnswerSheet';

const PAGE_SIZE = 50;

const LOGIN_STATUS_OPTIONS = [
  { value: 'all', label: 'All Login Statuses' },
  { value: 'NOT_STARTED', label: 'Not Started' },
  { value: 'LOGGED_IN', label: 'Logged In' },
  { value: 'SYSTEM_CHECK', label: 'System Check' },
  { value: 'RULES', label: 'Watching Rules/Video' },
  { value: 'IN_EXAM', label: 'In Exam' },
  { value: 'COMPLETED', label: 'Completed' },
];

export function StudentDataPage() {
  const [sessions, setSessions] = useState<RawSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [loginFilter, setLoginFilter] = useState('all');
  const [selected, setSelected] = useState<RawSession | null>(null);
  const [sheetSessionId, setSheetSessionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listCandidates({ page, limit: PAGE_SIZE }).then((res: any) => {
      if (cancelled) return;
      setSessions((res.candidates || []).map((candidate: any) => ({
        id: candidate.session?.id || `candidate-${candidate.id}`,
        candidate_id: candidate.id,
        exam_id: candidate.session?.exam_id || null,
        class_id: null,
        status: candidate.session?.status || 'NOT_STARTED',
        current_subject_index: null,
        current_question_index: null,
        question_started_at: null,
        started_at: candidate.session?.started_at || null,
        submitted_at: candidate.session?.submitted_at || null,
        last_activity_at: candidate.presence?.updated_at || candidate.last_verified_at || candidate.created_at,
        proctoring_warning_count: candidate.session?.proctoring_warning_count || 0,
        total_score: candidate.session?.total_score || null,
        max_score: candidate.session?.max_score || null,
        exam_candidates: candidate,
        exams: candidate.session?.exam || null,
        presence_stage: candidate.presence?.stage || null,
        is_likely_disconnected: false,
      })));
      setTotal(res.total || 0);
      setLoading(false);
    }).catch((err: unknown) => {
      console.error('[StudentDataPage] load failed:', err);
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page]);

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      const candidate = s.exam_candidates;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${candidate?.full_name || ''} ${candidate?.registration_id || ''} ${candidate?.hall_ticket_number || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (loginFilter !== 'all') {
        const stage = s.presence_stage || 'NOT_STARTED';
        if (stage !== loginFilter) return false;
      }
      return true;
    });
  }, [sessions, search, loginFilter]);

  const submittedOnPage = filtered.filter((s) => s.status === 'SUBMITTED').length;
  const inProgressOnPage = filtered.filter((s) => s.status === 'IN_PROGRESS').length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Student Data</h1>
        <p className="text-sm text-ink-500 mt-1">
          Every registered exam session — registration, hall ticket, class, exam, login and exam status, and timing — pulled live from the exam database.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <CountTile label="Total Records" value={total} tone="neutral" />
        <CountTile label="On This Page" value={filtered.length} tone="brand" />
        <CountTile label="In Progress (page)" value={inProgressOnPage} tone="warning" />
        <CountTile label="Submitted (page)" value={submittedOnPage} tone="success" />
      </div>

      <Card className="mb-4">
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex-1 min-w-0">
            <SearchInput value={search} onChange={setSearch} placeholder="Search by name, registration ID, or hall ticket…" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={loginFilter} onChange={setLoginFilter} options={LOGIN_STATUS_OPTIONS} />
          </div>
        </CardBody>
      </Card>

      {loading ? (
        <LoadingState label="Loading student data…" />
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={<IdCard size={22} />} title="No student records found" description="Adjust your filters or search terms." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="min-w-full divide-y divide-ink-100">
              <thead>
                <tr className="bg-ink-50/60">
                  <Th>Student</Th>
                  <Th>Class</Th>
                  <Th>Exam</Th>
                  <Th>Login Status</Th>
                  <Th>Exam Status</Th>
                  <Th>Start Time</Th>
                  <Th>Completion Time</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((s) => {
                  const candidate = s.exam_candidates;
                  const displayStatus = deriveStatus(s) as SessionDisplayStatus;
                  const loginMeta = s.presence_stage ? presenceStageMeta[s.presence_stage] : null;
                  return (
                    <tr key={s.id} onClick={() => setSelected(s)} className="cursor-pointer hover:bg-ink-50/70 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-ink-900 truncate">{candidate?.full_name || 'Unknown'}</p>
                        <p className="text-xs text-ink-400 truncate">{candidate?.registration_id || '—'} · {candidate?.hall_ticket_number || 'Not Available'}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-600">{candidate?.student_class || '—'}</td>
                      <td className="px-4 py-3 text-sm text-ink-600 max-w-[160px] truncate">{s.exams?.exam_name || '—'}</td>
                      <td className="px-4 py-3">
                        {loginMeta ? <Badge tone={loginMeta.tone}>{loginMeta.label}</Badge> : <Badge tone="neutral">Not Started</Badge>}
                      </td>
                      <td className="px-4 py-3"><Badge tone={sessionDisplayStatusMeta[displayStatus].tone} dot>{statusLabel(s)}</Badge></td>
                      <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{formatDateTime(s.started_at)}</td>
                      <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{formatDateTime(s.submitted_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-ink-100">
            <span className="text-xs text-ink-500">Page {page} of {totalPages} · {total} total</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" icon={<ChevronLeft size={14} />} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button size="sm" variant="secondary" icon={<ChevronRight size={14} />} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </Card>
      )}

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.exam_candidates?.full_name || 'Student Details'}
        subtitle={selected ? `${selected.exam_candidates?.registration_id || '—'} · ${selected.exam_candidates?.hall_ticket_number || 'Hall ticket: Not Available'}` : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <InfoTile label="Class" value={selected.exam_candidates?.student_class || '—'} />
              <InfoTile label="Exam" value={selected.exams?.exam_name || '—'} />
              <InfoTile
                label="Login Status"
                value={selected.presence_stage ? <Badge tone={presenceStageMeta[selected.presence_stage].tone}>{presenceStageMeta[selected.presence_stage].label}</Badge> : <Badge tone="neutral">Not Started</Badge>}
              />
              <InfoTile
                label="Exam Status"
                value={<Badge tone={sessionDisplayStatusMeta[deriveStatus(selected) as SessionDisplayStatus].tone} dot>{statusLabel(selected)}</Badge>}
              />
              <InfoTile label="Start Time" value={formatDateTime(selected.started_at)} />
              <InfoTile label="Completion Time" value={formatDateTime(selected.submitted_at)} />
            </div>

            {selected.status === 'SUBMITTED' && (
              <Card className="bg-ink-50/50">
                <CardBody className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-ink-700">Score</p>
                    <p className="text-xs text-ink-400 mt-0.5">Server-scored on submission</p>
                  </div>
                  <p className="text-lg font-bold text-ink-900 tabular-nums">
                    {selected.total_score ?? 0} / {selected.max_score ?? 0}
                    {selected.max_score ? ` · ${Math.round(((selected.total_score ?? 0) / selected.max_score) * 1000) / 10}%` : ''}
                  </p>
                </CardBody>
              </Card>
            )}

            <div className="grid grid-cols-2 gap-3">
              <InfoTile label="Violations" value={selected.proctoring_warning_count ?? 0} />
              <InfoTile label="Likely Disconnected" value={selected.is_likely_disconnected ? 'Yes' : 'No'} />
            </div>

            {!selected.id.startsWith('candidate-') && selected.status !== 'NOT_STARTED' && (
              <Button variant="primary" className="w-full" onClick={() => setSheetSessionId(selected.id)}>View Exam Attempt (all answers)</Button>
            )}

            {selected.candidate_id && <DeviceSessionPanel key={selected.candidate_id} candidateId={selected.candidate_id} />}
          </div>
        )}
      </Modal>
      <AttemptAnswerSheet sessionId={sheetSessionId} onClose={() => setSheetSessionId(null)} />
    </PageContainer>
  );
}

type DeviceSession = { createdAt: string; lastSeenAt: string; expiresAt: string; tokenExpiresAt: string; active: boolean };

// Shows the student's single device lease and lets an admin release a
// stuck one (e.g. a crashed laptop) so the student can sign in elsewhere.
// Release is audit-logged with the reason and never issues a login.
function DeviceSessionPanel({ candidateId }: { candidateId: string }) {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = () => getCandidateDeviceSession(candidateId)
    .then((data: { deviceSession: DeviceSession | null }) => setSession(data.deviceSession))
    .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unable to load the device session.'))
    .finally(() => setLoading(false));
  // Keyed by candidate in the parent, so state starts fresh per student.
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const release = async () => {
    if (reason.trim().length < 3) { setError('Enter a reason (at least 3 characters).'); return; }
    if (!window.confirm('Release this device session? The current device will be signed out, and the student must log in again with their own credentials.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await releaseCandidateDeviceSession(candidateId, reason.trim());
      setMessage('Device session released. The student can now log in on another device.');
      setReason('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to release the device session.');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-ink-200 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-900">Device Session</p>
        {!loading && (session
          ? <Badge tone={session.active ? 'success' : 'neutral'}>{session.active ? 'Active device' : 'Expired lease'}</Badge>
          : <Badge tone="neutral">No device signed in</Badge>)}
      </div>
      {loading ? <p className="text-xs text-ink-500">Loading…</p> : session && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <InfoTile label="Signed In" value={formatDateTime(session.createdAt)} />
            <InfoTile label="Last Seen" value={formatDateTime(session.lastSeenAt)} />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <TextInput value={reason} onChange={setReason} placeholder="Reason for release (required)" disabled={busy} />
            <Button variant="danger" size="sm" onClick={release} disabled={busy || reason.trim().length < 3}>
              {busy ? 'Releasing…' : 'Release device'}
            </Button>
          </div>
        </>
      )}
      {message && <p className="text-xs text-success-600" role="status">{message}</p>}
      {error && <p className="text-xs text-danger-600" role="alert">{error}</p>}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-500 whitespace-nowrap">{children}</th>;
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = { brand: 'text-brand-600', success: 'text-success-600', danger: 'text-danger-600', warning: 'text-warning-600', neutral: 'text-ink-700', accent: 'text-accent-600' };
  return (
    <div className="rounded-lg border border-ink-200 bg-surface px-3 py-2.5">
      <p className={`text-xl font-bold tabular-nums ${tones[tone]}`}>{value}</p>
      <p className="text-xs text-ink-500">{label}</p>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink-50 px-3 py-2.5">
      <p className="text-[11px] text-ink-400 uppercase tracking-wide font-semibold">{label}</p>
      <div className="text-sm font-semibold text-ink-900 mt-1 truncate">{value}</div>
    </div>
  );
}
