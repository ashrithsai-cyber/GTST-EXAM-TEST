import { useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { formatDateTime } from '../lib/format';
import { toResult } from '../lib/adapters';
import type { Result } from '../lib/types';
import { listResults } from '../../services/adminApi';
import { AttemptAnswerSheet } from '../components/AttemptAnswerSheet';

const PAGE_SIZE = 50;

export function ResultsPage() {
  const [results, setResults] = useState<Result[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sheetSessionId, setSheetSessionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listResults({ page, limit: PAGE_SIZE }).then((res: any) => {
      if (cancelled) return;
      setResults((res.results || []).map(toResult));
      setTotal(res.total || 0);
      setLoading(false);
    }).catch((err: unknown) => {
      console.error('[ResultsPage] load failed:', err);
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page]);

  const filtered = useMemo(() => {
    if (!search) return results;
    const q = search.toLowerCase();
    return results.filter((r) => `${r.studentName} ${r.registrationId}`.toLowerCase().includes(q));
  }, [results, search]);

  const avgPercent = filtered.length ? Math.round((filtered.reduce((sum, r) => sum + r.percentage, 0) / filtered.length) * 10) / 10 : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Results</h1>
        <p className="text-sm text-ink-500 mt-1">Server-scored submissions. No ranking is shown — this system defines no official ranking rule. Select a row to view the student's full answer sheet.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <CountTile label="Total Submissions" value={total} tone="neutral" />
        <CountTile label="On This Page" value={filtered.length} tone="brand" />
        <CountTile label="Avg. Score (this page)" value={`${avgPercent}%`} tone="success" />
      </div>

      <Card className="mb-4">
        <CardBody>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by student name or registration ID…" />
        </CardBody>
      </Card>

      {loading ? (
        <LoadingState label="Loading results…" />
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={<BarChart3 size={22} />} title="No results found" description="No exam has been submitted yet, or your search doesn't match anything." /></Card>
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
                {filtered.map((r) => (
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
              <Button size="sm" variant="secondary" icon={<ChevronLeft size={14} />} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button size="sm" variant="secondary" icon={<ChevronRight size={14} />} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
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
