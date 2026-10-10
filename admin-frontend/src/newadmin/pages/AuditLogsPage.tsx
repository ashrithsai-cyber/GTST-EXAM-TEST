import { useEffect, useMemo, useState } from 'react';
import { ScrollText, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardBody } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { EmptyState, LoadingState } from '../components/ui/States';
import { formatDateTime } from '../lib/format';
import { toAuditLogEntry } from '../lib/adapters';
import type { AuditLogEntry } from '../lib/types';
import { listAuditLogs } from '../../services/adminApi';

const PAGE_SIZE = 50;

const ACTION_TONE: Record<string, 'success' | 'brand' | 'danger' | 'warning' | 'neutral'> = {
  CREATE: 'success',
  UPDATE: 'brand',
  DELETE: 'danger',
  STATUS_CHANGE: 'warning',
};

export function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAuditLogs({ page, limit: PAGE_SIZE }).then((res: any) => {
      if (cancelled) return;
      setLogs((res.logs || []).map(toAuditLogEntry));
      setTotal(res.total || 0);
      setLoading(false);
    }).catch((err: unknown) => {
      console.error('[AuditLogsPage] load failed:', err);
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page]);

  const filtered = useMemo(() => {
    if (!search) return logs;
    const q = search.toLowerCase();
    return logs.filter((l) => `${l.actorName} ${l.action} ${l.resourceType}`.toLowerCase().includes(q));
  }, [logs, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Audit Logs</h1>
        <p className="text-sm text-ink-500 mt-1">Every admin action that mutates data, most recent first.</p>
      </div>

      <Card className="mb-4">
        <CardBody>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by admin, action, or resource type…" />
        </CardBody>
      </Card>

      {loading ? (
        <LoadingState label="Loading audit logs…" />
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={<ScrollText size={22} />} title="No audit log entries" description="No matching admin actions found." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="min-w-full divide-y divide-ink-100">
              <thead>
                <tr className="bg-ink-50/60">
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Resource</Th>
                  <Th>IP Address</Th>
                  <Th>Time</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((l) => (
                  <tr key={l.id} className="hover:bg-ink-50/70 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-ink-900">{l.actorName || 'Unknown'}</p>
                      <p className="text-xs text-ink-400">{l.actorEmail || ''}</p>
                    </td>
                    <td className="px-4 py-3"><Badge tone={ACTION_TONE[l.action] || 'neutral'}>{l.action}</Badge></td>
                    <td className="px-4 py-3 text-sm text-ink-600">{l.resourceType}{l.resourceId ? ` · ${l.resourceId.slice(0, 8)}…` : ''}</td>
                    <td className="px-4 py-3 text-xs text-ink-400">Not Available</td>
                    <td className="px-4 py-3 text-xs text-ink-500 whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
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
    </PageContainer>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-500 whitespace-nowrap">{children}</th>;
}
