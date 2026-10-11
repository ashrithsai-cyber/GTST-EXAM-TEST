import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldAlert, Check, FileText } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput, Select, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/States';
import { Modal } from '../components/ui/Modal';
import { formatDateTime } from '../lib/format';
import { AttemptAnswerSheet } from '../components/AttemptAnswerSheet';
// One record per student attempt, built from the existing exam_events
// table (GET /api/admin/proctoring/events) — see buildStudentViolations.
import { fetchStudentViolations, VIOLATION_TYPE_OPTIONS } from '../../services/monitoring';
import {
  exportProctoringEventsCsv,
  exportProctoringEventsXlsx,
  reviewProctoringEvent,
} from '../../services/adminApi';

const POLL_MS = 15000;

type ViolationEvent = { id: string; type: string; label: string; message: string; reviewed: boolean; createdAt: string };
type StudentViolations = {
  id: string; sessionId: string; studentName: string; registrationId: string; className: string;
  examId: string | null; examName: string; attemptStatus: string | null;
  total: number; countsByType: Record<string, number>; lastAt: string; events: ViolationEvent[];
  unreviewedIds: string[]; rules: { type: string; label: string; count: number }[]; reviewStatus: 'reviewed' | 'unreviewed';
};

function mergeViolationRecords(current: StudentViolations[], incoming: StudentViolations[]) {
  const merged = new Map(current.map((record) => [record.id, record]));
  for (const update of incoming) {
    const previous = merged.get(update.id);
    if (!previous) {
      merged.set(update.id, update);
      continue;
    }
    const eventsById = new Map([...previous.events, ...update.events].map((event) => [event.id, event]));
    const events = Array.from(eventsById.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const countsByType: Record<string, number> = {};
    for (const event of events) countsByType[event.type] = (countsByType[event.type] || 0) + 1;
    const unreviewedIds = events.filter((event) => !event.reviewed).map((event) => event.id);
    const rules = Object.entries(countsByType)
      .map(([type, count]) => ({ type, label: events.find((event) => event.type === type)?.label || type, count }))
      .sort((a, b) => b.count - a.count);
    merged.set(update.id, {
      ...previous,
      ...update,
      total: events.length,
      countsByType,
      lastAt: events[0]?.createdAt || previous.lastAt,
      events,
      unreviewedIds,
      rules,
      reviewStatus: unreviewedIds.length ? 'unreviewed' : 'reviewed',
    });
  }
  return Array.from(merged.values()).sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
  );
}

export function ViolationsPage() {
  const [records, setRecords] = useState<StudentViolations[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [examFilter, setExamFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [reviewFilter, setReviewFilter] = useState('all');
  const [classFilter, setClassFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetSessionId, setSheetSessionId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState('');

  const polling = useRef(false);
  const latestEventAt = useRef<string | null>(null);

  const load = async (incremental = false) => {
    polling.current = true;
    try {
      const next = await fetchStudentViolations(incremental ? latestEventAt.current : null);
      const newestEventAt = next.flatMap((record) => record.events).reduce<string | null>(
        (latest, event) => !latest || new Date(event.createdAt) > new Date(latest) ? event.createdAt : latest,
        latestEventAt.current
      );
      if (newestEventAt) latestEventAt.current = newestEventAt;
      setRecords((current) => incremental ? mergeViolationRecords(current, next) : next);
      setLoadError('');
    } catch (err) {
      console.error('[ViolationsPage] refresh failed:', err);
      setLoadError(err instanceof Error ? err.message : 'Unable to load violations.');
    } finally {
      polling.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Every refresh pages through all events, which grow during the exam.
    // Skip a tick while one is still running so slow responses never
    // stack up concurrent reloads (manual reloads after a review still run).
    const interval = setInterval(() => { if (!polling.current) load(true); }, POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const examOptions = useMemo(() => {
    const exams = new Map<string, string>();
    records.forEach((r) => { if (r.examId) exams.set(r.examId, r.examName); });
    return [{ value: 'all', label: 'All Exams' }, ...Array.from(exams, ([value, label]) => ({ value, label }))];
  }, [records]);

  const filtered = useMemo(() => records.map((r) => {
    if (search) {
      const q = search.toLowerCase();
      if (!`${r.studentName} ${r.registrationId}`.toLowerCase().includes(q)) return null;
    }
    if (examFilter !== 'all' && r.examId !== examFilter) return null;
    if (classFilter.trim() && r.className.toLowerCase() !== `class ${classFilter.trim()}`.toLowerCase()) return null;
    const visibleEvents = r.events.filter((event) => {
      const at = new Date(event.createdAt).getTime();
      if (from && at < new Date(`${from}T00:00:00.000Z`).getTime()) return false;
      if (to && at > new Date(`${to}T23:59:59.999Z`).getTime()) return false;
      if (typeFilter !== 'all' && event.type !== typeFilter) return false;
      if (reviewFilter === 'reviewed' && !event.reviewed) return false;
      if (reviewFilter === 'unreviewed' && event.reviewed) return false;
      return true;
    });
    if (!visibleEvents.length) return null;
    const countsByType: Record<string, number> = {};
    for (const event of visibleEvents) countsByType[event.type] = (countsByType[event.type] || 0) + 1;
    const unreviewedIds = visibleEvents.filter((event) => !event.reviewed).map((event) => event.id);
    const rules = Object.entries(countsByType)
      .map(([type, count]) => ({ type, label: visibleEvents.find((event) => event.type === type)?.label || type, count }))
      .sort((a, b) => b.count - a.count);
    return {
      ...r,
      events: visibleEvents,
      total: visibleEvents.length,
      countsByType,
      unreviewedIds,
      rules,
      lastAt: visibleEvents[0].createdAt,
      reviewStatus: unreviewedIds.length ? 'unreviewed' as const : 'reviewed' as const,
    };
  }).filter((r): r is StudentViolations => r !== null), [
    records, search, examFilter, classFilter, typeFilter, reviewFilter, from, to,
  ]);

  const selected = records.find((r) => r.id === selectedId) || null;
  const totalViolations = filtered.reduce((sum, r) => sum + (typeFilter === 'all' ? r.total : r.countsByType[typeFilter] || 0), 0);

  const exportParams = {
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(examFilter !== 'all' ? { examId: examFilter } : {}),
    ...(typeFilter !== 'all' ? { eventType: typeFilter } : {}),
    ...(reviewFilter !== 'all' ? { reviewed: String(reviewFilter === 'reviewed') } : {}),
    ...(classFilter.trim() ? { className: classFilter.trim() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  const download = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    setExportError('');
    try {
      await (format === 'csv'
        ? exportProctoringEventsCsv(exportParams)
        : exportProctoringEventsXlsx(exportParams));
    } catch (err) {
      console.error(`[ViolationsPage] ${format.toUpperCase()} export failed:`, err);
      setExportError(err instanceof Error ? err.message : 'Unable to export violations. Please retry.');
    } finally {
      setExporting(false);
    }
  };

  const markReviewed = async (record: StudentViolations) => {
    setReviewing(true);
    setReviewError('');
    try {
      await Promise.all(record.unreviewedIds.map((id) => reviewProctoringEvent(id)));
      await load();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Unable to mark as reviewed.');
    } finally {
      setReviewing(false);
    }
  };

  if (loading) {
    return <PageContainer><div className="flex items-center justify-center py-24 text-ink-400 text-sm">Loading violations…</div></PageContainer>;
  }

  return (
    <PageContainer>
      <div className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-900 tracking-tight">Violations</h1>
            <p className="text-sm text-ink-500 mt-1">Proctoring violations per student attempt, with how many times each rule was broken. Most recent first.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<FileText size={14} />} disabled={exporting} onClick={() => download('csv')}>
              {exporting ? 'Preparing…' : 'Export CSV'}
            </Button>
            <Button variant="secondary" icon={<FileText size={14} />} disabled={exporting} onClick={() => download('xlsx')}>
              {exporting ? 'Preparing…' : 'Export Excel'}
            </Button>
          </div>
        </div>
      </div>

      {exportError && <div className="mb-4 rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700" role="alert">{exportError}</div>}

      {loadError && (
        <div className="mb-4 rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700" role="alert">{loadError}</div>
      )}

      <Card className="mb-4">
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex-1 min-w-0">
            <SearchInput value={search} onChange={setSearch} placeholder="Search by student name or registration ID…" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={examFilter} onChange={setExamFilter} options={examOptions} />
            <Select value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: 'All Violation Types' }, ...VIOLATION_TYPE_OPTIONS]} />
            <Select value={reviewFilter} onChange={setReviewFilter} options={[{ value: 'all', label: 'All Review States' }, { value: 'unreviewed', label: 'Unreviewed' }, { value: 'reviewed', label: 'Reviewed' }]} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <TextInput value={classFilter} onChange={setClassFilter} placeholder="Class name (exact)…" />
            <label className="text-xs text-ink-500">From<TextInput type="date" value={from} onChange={setFrom} /></label>
            <label className="text-xs text-ink-500">Through<TextInput type="date" value={to} onChange={setTo} /></label>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <CountTile label="Students Flagged" value={filtered.length} tone="neutral" />
        <CountTile label={typeFilter === 'all' ? 'Total Violations' : 'Matching Violations'} value={totalViolations} tone="brand" />
        <CountTile label="Unreviewed Students" value={filtered.filter((r) => r.reviewStatus === 'unreviewed').length} tone="warning" />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldAlert size={22} />}
            title="No violations found"
            description={records.length ? 'No student matches these filters.' : 'Nothing has been recorded yet. Violations are only recorded while Proctoring is enabled in Exam Settings.'}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="min-w-full divide-y divide-ink-100">
              <thead>
                <tr className="bg-ink-50/60">
                  <Th>Student</Th>
                  <Th>Exam</Th>
                  <Th>Violations by Rule</Th>
                  <Th>Total</Th>
                  <Th>Last Violation</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((r) => (
                  <tr key={r.id} onClick={() => { setReviewError(''); setSelectedId(r.id); }} className="cursor-pointer hover:bg-ink-50/70 transition-colors align-top">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-ink-900">{r.studentName}</p>
                      <p className="text-xs text-ink-400">{r.registrationId} · {r.className}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-600">{r.examName}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5 max-w-md">
                        {r.rules.map((rule) => (
                          <Badge key={rule.type} tone={typeFilter === rule.type ? 'brand' : 'neutral'}>{rule.label} ×{rule.count}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-ink-900 tabular-nums">{r.total}</td>
                    <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{formatDateTime(r.lastAt)}</td>
                    <td className="px-4 py-3"><Badge tone={r.reviewStatus === 'reviewed' ? 'success' : 'warning'} dot>{r.reviewStatus}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.studentName || ''}
        subtitle={selected ? `${selected.registrationId} · ${selected.className} · ${selected.examName}` : ''}
        size="xl"
        footer={selected ? (
          <>
            <Button variant="secondary" icon={<FileText size={14} />} onClick={() => setSheetSessionId(selected.sessionId)}>View Exam Attempt</Button>
            {selected.reviewStatus !== 'reviewed' && (
              <Button variant="success" icon={<Check size={14} />} onClick={() => markReviewed(selected)} disabled={reviewing}>
                {reviewing ? 'Marking…' : 'Mark All as Reviewed'}
              </Button>
            )}
          </>
        ) : undefined}
      >
        {selected && (
          <div className="space-y-5">
            {reviewError && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2.5 text-sm text-danger-700">{reviewError}</div>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <InfoTile label="Total Violations" value={selected.total} />
              <InfoTile label="Attempt Status" value={selected.attemptStatus || '—'} />
              <InfoTile label="Last Violation" value={formatDateTime(selected.lastAt)} />
            </div>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">Count by Rule</h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {selected.rules.map((rule) => <InfoTile key={rule.type} label={rule.label} value={`${rule.count} time${rule.count === 1 ? '' : 's'}`} />)}
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-2">All Violations ({selected.events.length})</h4>
              <div className="overflow-x-auto rounded-lg border border-ink-200">
                <table className="min-w-full divide-y divide-ink-100 text-sm">
                  <thead>
                    <tr className="bg-ink-50/60"><Th>Date / Time</Th><Th>Violation</Th><Th>Details</Th><Th>Reviewed</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {selected.events.map((e) => (
                      <tr key={e.id}>
                        <td className="px-4 py-2 text-xs text-ink-500 whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                        <td className="px-4 py-2 text-ink-800 whitespace-nowrap">{e.label}</td>
                        <td className="px-4 py-2 text-xs text-ink-500">{e.message || '—'}</td>
                        <td className="px-4 py-2">{e.reviewed ? <Badge tone="success">Yes</Badge> : <Badge tone="warning">No</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </Modal>

      <AttemptAnswerSheet sessionId={sheetSessionId} onClose={() => setSheetSessionId(null)} />
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
      <div className="text-sm font-semibold text-ink-900 mt-1">{value}</div>
    </div>
  );
}
