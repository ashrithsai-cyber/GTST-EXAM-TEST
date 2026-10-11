import { useEffect, useMemo, useState } from 'react';
import { Users, Clock } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SearchInput, Select } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/States';
import { Modal } from '../components/ui/Modal';
import { formatRelative, formatTime, formatDateTime, sessionDisplayStatusMeta } from '../lib/format';
import type { RawSession, SessionDisplayStatus } from '../lib/types';
// Status/progress/violation-count derivation reused verbatim from the
// existing admin dashboard's shared helper — see the file header there
// for why this proxy-based "disconnected" signal is honestly labeled,
// not a true heartbeat.
import { fetchMonitoringData, deriveStatus, statusLabel, progressForSession } from '../../services/monitoring';
import { listProctoringEvents } from '../../services/adminApi';

const POLL_MS = 10000;

const EVENT_LABELS: Record<string, string> = {
  MULTIPLE_FACE: 'Multiple faces detected',
  NO_FACE: 'No face detected',
  CAMERA_DISABLED: 'Camera disabled',
  MICROPHONE_DISABLED: 'Microphone disabled',
  TAB_SWITCH: 'Tab switch',
  WINDOW_BLUR: 'Window lost focus',
  FULLSCREEN_EXIT: 'Fullscreen exit',
  RIGHT_CLICK: 'Right click',
  COPY_PASTE: 'Copy/paste attempt',
  NETWORK_DISCONNECT: 'Network disconnected',
  NETWORK_RECONNECT: 'Network reconnected',
  EXAM_LEFT: 'Left exam page',
};

function violationCountFor(counters: any, savedWarnings: number): number {
  return typeof counters?.violationCount === 'number' ? counters.violationCount : savedWarnings;
}

export function LiveStudentsPage({ onSync }: { onSync: (status: 'connected' | 'reconnecting' | 'offline') => void }) {
  const [sessions, setSessions] = useState<RawSession[]>([]);
  const [eventCounts, setEventCounts] = useState<Map<string, any>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [monitoringWarning, setMonitoringWarning] = useState('');
  const [retry, setRetry] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [examFilter, setExamFilter] = useState('all');
  const [violationFilter, setViolationFilter] = useState('all');
  const [sortBy, setSortBy] = useState('recent');
  const [selected, setSelected] = useState<RawSession | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Do not overlap polling while a previous request is still running.
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await fetchMonitoringData();
        if (cancelled) return;
        setSessions(data.sessions);
        setEventCounts(data.eventCounts);
        setMonitoringWarning(data.monitoringWarning || '');
        setLoadError('');
        setHasLoaded(true);
        onSync('connected');
      } catch (err) {
        console.error('[LiveStudentsPage] refresh failed:', err);
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Unable to load live students.');
          onSync('reconnecting');
        }
      } finally {
        if (!cancelled) setLoading(false);
        inFlight = false;
      }
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry, onSync]);

  useEffect(() => {
    if (!selected) {
      setSelectedEvents([]);
      return;
    }
    let cancelled = false;
    listProctoringEvents({ sessionId: selected.id, limit: 50 }).then((res: any) => {
      if (!cancelled) setSelectedEvents(res.events || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected]);

  const examNames = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.exams?.exam_name).filter(Boolean))) as string[],
    [sessions]
  );

  const rows = useMemo(() => {
    return sessions.map((s) => {
      const progress = progressForSession(s);
      const counters = eventCounts.get(s.id);
      return {
        session: s,
        displayStatus: deriveStatus(s) as SessionDisplayStatus,
        label: statusLabel(s) as string,
        progress,
        violationCount: violationCountFor(counters, s.proctoring_warning_count || 0),
      };
    });
  }, [sessions, eventCounts]);

  const filtered = useMemo(() => {
    let result = rows.filter((r) => {
      const s = r.session;
      const candidate = s.exam_candidates;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${candidate?.full_name || ''} ${candidate?.registration_id || ''} ${candidate?.hall_ticket_number || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter !== 'all' && r.displayStatus !== statusFilter) return false;
      if (examFilter !== 'all' && s.exams?.exam_name !== examFilter) return false;
      if (violationFilter === 'has' && r.violationCount === 0) return false;
      if (violationFilter === 'none' && r.violationCount > 0) return false;
      return true;
    });
    if (sortBy === 'recent') result = [...result].sort((a, b) => new Date(b.session.last_activity_at || 0).getTime() - new Date(a.session.last_activity_at || 0).getTime());
    if (sortBy === 'name') result = [...result].sort((a, b) => (a.session.exam_candidates?.full_name || '').localeCompare(b.session.exam_candidates?.full_name || ''));
    if (sortBy === 'progress') result = [...result].sort((a, b) => (b.progress.total ? b.progress.attempted / b.progress.total : 0) - (a.progress.total ? a.progress.attempted / a.progress.total : 0));
    if (sortBy === 'violations') result = [...result].sort((a, b) => b.violationCount - a.violationCount);
    return result;
  }, [rows, search, statusFilter, examFilter, violationFilter, sortBy]);

  const selectedRow = selected ? rows.find((r) => r.session.id === selected.id) : undefined;

  if (loading && !hasLoaded && !loadError) {
    return <PageContainer><div className="flex items-center justify-center py-24 text-ink-400 text-sm">Loading live students…</div></PageContainer>;
  }

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Live Students</h1>
        <p className="text-sm text-ink-500 mt-1">Real-time monitoring of all active, blocked and recently submitted exam sessions</p>
      </div>

      {loadError && <div className="rounded-lg border border-danger-200 bg-danger-50 p-4 mb-4" role="alert">
        <p className="text-sm text-danger-700">{loadError}</p>
        {hasLoaded && <p className="text-xs text-danger-700 mt-1">Showing the last successfully loaded data. It may be out of date.</p>}
        <button type="button" className="mt-2 text-sm font-semibold underline text-danger-700" onClick={() => setRetry(value => value + 1)}>Retry Live Students</button>
      </div>}
      {monitoringWarning && <p className="rounded-lg border border-warning-200 bg-warning-50 p-4 mb-4 text-sm text-warning-700" role="status">{monitoringWarning} Session status and warning totals remain available.</p>}

      {!hasLoaded ? null : <>

      <Card className="mb-4">
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex-1 min-w-0">
            <SearchInput value={search} onChange={setSearch} placeholder="Search by name, registration ID, or hall ticket…" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={statusFilter} onChange={setStatusFilter} options={[
              { value: 'all', label: 'All Statuses' },
              { value: 'active', label: 'In Exam' },
              { value: 'warning', label: 'In Exam (Warning)' },
              { value: 'disconnected', label: 'Disconnected' },
              { value: 'critical', label: 'Blocked' },
              { value: 'completed', label: 'Completed' },
            ]} />
            <Select value={examFilter} onChange={setExamFilter} options={[{ value: 'all', label: 'All Exams' }, ...examNames.map((n) => ({ value: n, label: n }))]} />
            <Select value={violationFilter} onChange={setViolationFilter} options={[{ value: 'all', label: 'All Violations' }, { value: 'has', label: 'Has Violations' }, { value: 'none', label: 'No Violations' }]} />
            <Select value={sortBy} onChange={setSortBy} options={[{ value: 'recent', label: 'Sort: Recent' }, { value: 'name', label: 'Sort: Name' }, { value: 'progress', label: 'Sort: Progress' }, { value: 'violations', label: 'Sort: Violations' }]} />
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        <CountTile label="Total" value={filtered.length} tone="neutral" />
        <CountTile label="In Exam" value={filtered.filter((r) => r.displayStatus === 'active' || r.displayStatus === 'warning').length} tone="brand" />
        <CountTile label="Completed" value={filtered.filter((r) => r.displayStatus === 'completed').length} tone="success" />
        <CountTile label="Disconnected" value={filtered.filter((r) => r.displayStatus === 'disconnected').length} tone="danger" />
        <CountTile label="Blocked" value={filtered.filter((r) => r.displayStatus === 'critical').length} tone="warning" />
        <CountTile label="With Violations" value={filtered.filter((r) => r.violationCount > 0).length} tone="accent" />
      </div>

      {filtered.length === 0 ? (
        <Card><EmptyState icon={<Users size={22} />} title="No students found" description="Adjust your filters or search terms." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="min-w-full divide-y divide-ink-100">
              <thead>
                <tr className="bg-ink-50/60">
                  <Th>Student</Th>
                  <Th>Exam</Th>
                  <Th>Status</Th>
                  <Th>Progress</Th>
                  <Th>Subject</Th>
                  <Th>Camera</Th>
                  <Th>Mic</Th>
                  <Th>Network</Th>
                  <Th>Violations</Th>
                  <Th>Last Activity</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((r) => {
                  const s = r.session;
                  const candidate = s.exam_candidates;
                  return (
                    <tr key={s.id} onClick={() => setSelected(s)} className="cursor-pointer hover:bg-ink-50/70 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 text-xs font-semibold">
                            {(candidate?.full_name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-ink-900 truncate">{candidate?.full_name || 'Unknown'}</p>
                            <p className="text-xs text-ink-400 truncate">{candidate?.registration_id || '—'} · {candidate?.hall_ticket_number || 'Not Available'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-600 max-w-[160px] truncate">{s.exams?.exam_name || '—'}</td>
                      <td className="px-4 py-3"><Badge tone={sessionDisplayStatusMeta[r.displayStatus].tone} dot>{r.label}</Badge></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                            <div className="h-full rounded-full bg-brand-500" style={{ width: `${r.progress.total ? (r.progress.attempted / r.progress.total) * 100 : 0}%` }} />
                          </div>
                          <span className="text-xs text-ink-500 tabular-nums">{r.progress.available ? `${r.progress.attempted}/${r.progress.total}` : '—'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-600">{r.progress.currentSubject}</td>
                      <td className="px-4 py-3 text-xs text-ink-400">Not Available</td>
                      <td className="px-4 py-3 text-xs text-ink-400">Not Available</td>
                      <td className="px-4 py-3 text-xs text-ink-400">Not Available</td>
                      <td className="px-4 py-3">{r.violationCount > 0 ? <Badge tone="danger">{r.violationCount}</Badge> : <span className="text-xs text-ink-400">0</span>}</td>
                      <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{formatRelative(s.last_activity_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      </>}

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.exam_candidates?.full_name || ''}
        subtitle={selected ? `${selected.exam_candidates?.registration_id || '—'} · ${selected.exam_candidates?.hall_ticket_number || 'Hall ticket: Not Available'}` : ''}
        size="xl"
      >
        {selected && selectedRow && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <InfoTile label="Status" value={<Badge tone={sessionDisplayStatusMeta[selectedRow.displayStatus].tone} dot>{selectedRow.label}</Badge>} />
              <InfoTile label="Exam" value={selected.exams?.exam_name || '—'} />
              <InfoTile label="Current Subject" value={selectedRow.progress.currentSubject} />
              <InfoTile label="Session Start" value={formatTime(selected.started_at)} />
            </div>

            <Card className="bg-ink-50/50">
              <CardBody>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-ink-700">Exam Progress</span>
                  <span className="text-sm font-bold text-ink-900 tabular-nums">
                    {selectedRow.progress.available
                      ? `${selectedRow.progress.attempted} / ${selectedRow.progress.total} · ${Math.round((selectedRow.progress.attempted / selectedRow.progress.total) * 100)}%`
                      : 'Snapshot unavailable'}
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-ink-200 overflow-hidden">
                  <div className="h-full rounded-full bg-brand-600 transition-all duration-500" style={{ width: `${selectedRow.progress.available ? (selectedRow.progress.attempted / selectedRow.progress.total) * 100 : 0}%` }} />
                </div>
              </CardBody>
            </Card>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">Device / Network Status</h4>
              <p className="text-xs text-ink-400 bg-ink-50/50 rounded-lg px-3 py-2.5">
                Not Available — this system does not track continuous camera/microphone/network state, only discrete
                proctoring events (shown below) when something goes wrong.
              </p>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">Proctoring Events Timeline ({selectedEvents.length})</h4>
              {selectedEvents.length === 0 ? (
                <p className="text-sm text-ink-400 py-3 text-center bg-ink-50/50 rounded-lg">No proctoring events recorded</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                  {selectedEvents.map((e) => (
                    <div key={e.id} className="flex items-start gap-3 rounded-lg bg-ink-50/60 px-3 py-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-500"><Clock size={14} /></div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink-800">{EVENT_LABELS[e.event_type] || e.event_type}</p>
                        {e.event_message && <p className="text-xs text-ink-500 mt-0.5">{e.event_message}</p>}
                        <p className="text-xs text-ink-400 mt-0.5">{formatDateTime(e.created_at)}</p>
                      </div>
                      <Badge tone={e.reviewed ? 'success' : 'warning'}>{e.reviewed ? 'Reviewed' : 'Unreviewed'}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
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
