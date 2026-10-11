import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput, Select, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { formatDateTime } from '../lib/format';
import { toResult } from '../lib/adapters';
import type { Result } from '../lib/types';
import { exportResultsCsv, exportResultsXlsx, listExams, listResults } from '../../services/adminApi';
import { AttemptAnswerSheet } from '../components/AttemptAnswerSheet';

const PAGE_SIZE = 50;

export function ResultsPage() {
  const [results, setResults] = useState<Result[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [exams, setExams] = useState<{ id: string; exam_name: string }[]>([]);
  const [examId, setExamId] = useState('');
  const [className, setClassName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sheetSessionId, setSheetSessionId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  useEffect(() => {
    listExams().then((res: any) => setExams(res.exams || [])).catch((err: unknown) => {
      console.error('[ResultsPage] exam filter options failed:', err);
    });
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setLoading(true);
      setError('');
      setPage(1);
      setSearch(value.trim());
    }, 250);
  };

  useEffect(() => {
    let cancelled = false;
    const params = {
      page: String(page),
      limit: String(PAGE_SIZE),
      ...(search ? { search } : {}),
      ...(examId ? { examId } : {}),
      ...(className.trim() ? { className: className.trim() } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
    listResults(params).then((res: any) => {
      if (cancelled) return;
      setResults((res.results || []).map(toResult));
      setTotal(res.total || 0);
      setLoading(false);
    }).catch((err: unknown) => {
      console.error('[ResultsPage] load failed:', err);
      if (!cancelled) {
        setError('Unable to load results. Check your connection and retry.');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [page, search, examId, className, from, to, retry]);

  const avgPercent = results.length ? Math.round((results.reduce((sum, r) => sum + r.percentage, 0) / results.length) * 10) / 10 : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const exportParams = useMemo(() => ({
    ...(search ? { search } : {}),
    ...(examId ? { examId } : {}),
    ...(className.trim() ? { className: className.trim() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }), [search, examId, className, from, to]);

  const download = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    setExportError('');
    try {
      await (format === 'csv' ? exportResultsCsv(exportParams) : exportResultsXlsx(exportParams));
    } catch (err) {
      console.error(`[ResultsPage] ${format.toUpperCase()} export failed:`, err);
      setExportError(err instanceof Error ? err.message : 'Unable to export results. Please retry.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageContainer>
      <div className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-900 tracking-tight">Results</h1>
            <p className="text-sm text-ink-500 mt-1">Server-scored submissions. No ranking is shown — this system defines no official ranking rule. Select a row to view the student's full answer sheet.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Download size={15} />} disabled={exporting} onClick={() => download('csv')}>
              {exporting ? 'Preparing…' : 'Export CSV'}
            </Button>
            <Button variant="secondary" icon={<Download size={15} />} disabled={exporting} onClick={() => download('xlsx')}>
              {exporting ? 'Preparing…' : 'Export Excel'}
            </Button>
          </div>
        </div>
      </div>
      {exportError && <p className="mb-3 rounded-lg border border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger-700" role="alert">{exportError}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <CountTile label="Total Submissions" value={total} tone="neutral" />
        <CountTile label="On This Page" value={results.length} tone="brand" />
        <CountTile label="Avg. Score (this page)" value={`${avgPercent}%`} tone="success" />
      </div>

      <Card className="mb-4">
        <CardBody>
          <SearchInput value={searchInput} onChange={handleSearchChange} placeholder="Search all results by student name or registration ID…" />
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Select value={examId} onChange={(value) => { setPage(1); setExamId(value); }} options={[{ value: '', label: 'All Exams' }, ...exams.map((exam) => ({ value: exam.id, label: exam.exam_name }))]} />
            <TextInput value={className} onChange={(value) => { setPage(1); setClassName(value); }} placeholder="Filter by class…" />
            <label className="text-xs text-ink-500">Submitted from<TextInput type="date" value={from} onChange={(value) => { setPage(1); setFrom(value); }} /></label>
            <label className="text-xs text-ink-500">Submitted through<TextInput type="date" value={to} onChange={(value) => { setPage(1); setTo(value); }} /></label>
          </div>
        </CardBody>
      </Card>

      {loading ? (
        <LoadingState label="Loading results…" />
      ) : error ? (
        <Card>
          <CardBody>
            <div className="text-center" role="alert">
              <p className="text-sm text-danger-700">{error}</p>
              <Button className="mt-3" onClick={() => { setLoading(true); setError(''); setRetry((value) => value + 1); }}>Retry</Button>
            </div>
          </CardBody>
        </Card>
      ) : results.length === 0 ? (
        <Card><EmptyState icon={<BarChart3 size={22} />} title="No results found" description={search ? 'No submitted results match this search.' : 'No exam has been submitted yet.'} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="min-w-full divide-y divide-ink-100">
              <thead>
                <tr className="bg-ink-50/60">
                  <Th>Student</Th>
                  <Th>Class</Th>
                  <Th>Submitted</Th>
                  <Th align="right">Score</Th>
                  <Th align="right">Percentage</Th>
                  <Th align="right">Answers</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {results.map((r) => (
                  <tr key={r.id} onClick={() => setSheetSessionId(r.id)} className="cursor-pointer hover:bg-ink-50/70 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-ink-900">{r.studentName}</p>
                      <p className="text-xs text-ink-400">{r.registrationId}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-600">{r.studentClass || '—'}</td>
                    <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{formatDateTime(r.submittedAt)}</td>
                    <td className="px-4 py-3 text-right text-sm text-ink-700 tabular-nums">{r.score} / {r.maxScore}</td>
                    <td className="px-4 py-3 text-right">
                      <Badge tone={r.percentage >= 50 ? 'success' : 'warning'}>{r.percentage}%</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setSheetSessionId(r.id); }}>View</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-ink-100">
            <span className="text-xs text-ink-500">Page {page} of {totalPages} · {total} total</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" icon={<ChevronLeft size={14} />} disabled={page <= 1} onClick={() => { setLoading(true); setError(''); setPage((p) => Math.max(1, p - 1)); }}>Prev</Button>
              <Button size="sm" variant="secondary" icon={<ChevronRight size={14} />} disabled={page >= totalPages} onClick={() => { setLoading(true); setError(''); setPage((p) => p + 1); }}>Next</Button>
            </div>
          </div>
        </Card>
      )}
      <AttemptAnswerSheet sessionId={sheetSessionId} onClose={() => setSheetSessionId(null)} />
    </PageContainer>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider text-ink-500 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function CountTile({ label, value, tone }: { label: string; value: React.ReactNode; tone: string }) {
  const tones: Record<string, string> = { brand: 'text-brand-600', success: 'text-success-600', danger: 'text-danger-600', warning: 'text-warning-600', neutral: 'text-ink-700', accent: 'text-accent-600' };
  return (
    <div className="rounded-lg border border-ink-200 bg-surface px-3 py-2.5">
      <p className={`text-xl font-bold tabular-nums ${tones[tone]}`}>{value}</p>
      <p className="text-xs text-ink-500">{label}</p>
    </div>
  );
}
