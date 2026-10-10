import { useEffect, useState } from 'react';
import { Users, PenLine, CheckCircle2, Clock } from 'lucide-react';
import { StatCard } from '../components/ui/StatCard';
import { PageContainer } from '../components/ui/PageHeader';
import { toDashboardStats } from '../lib/adapters';
import type { DashboardStats } from '../lib/types';
import { getDashboard } from '../../services/adminApi';

const POLL_MS = 10000;

export function DashboardPage({ onSync }: {
  onSync: (status: 'connected' | 'reconnecting' | 'offline') => void;
}) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Skip a tick while the previous refresh is still running, so a slow
    // database during the live exam never stacks up concurrent reloads.
    let inFlight = false;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const dashboardRes = await getDashboard();
        if (cancelled) return;
        setStats(toDashboardStats(dashboardRes.dashboard));
        setLoading(false);
        onSync('connected');
      } catch (err) {
        console.error('[DashboardPage] refresh failed:', err);
        if (!cancelled) onSync('reconnecting');
      } finally {
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
  }, []);

  if (loading || !stats) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center py-24 text-ink-400 text-sm">Loading dashboard…</div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Dashboard</h1>
        <p className="text-sm text-ink-500 mt-1">Real-time overview of exam activity</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Logged In"
          value={stats.totalCandidates}
          icon={<Users size={20} />}
          tone="neutral"
          sublabel="Verified candidates (total)"
        />
        <StatCard label="Writing Exam" value={stats.sessionsInProgress} icon={<PenLine size={20} />} tone="brand" sublabel="Currently in progress" />
        <StatCard label="Completed" value={stats.sessionsSubmitted} icon={<CheckCircle2 size={20} />} tone="success" sublabel="Submitted" />
        <StatCard label="Not Started" value={stats.sessionsNotStarted} icon={<Clock size={20} />} tone="warning" sublabel="Active exam, no session yet" />
      </div>
    </PageContainer>
  );
}
