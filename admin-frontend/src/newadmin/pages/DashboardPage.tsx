import { useEffect, useState } from 'react';
import { Users, PenLine, CheckCircle2, Clock, UserCheck } from 'lucide-react';
import { StatCard } from '../components/ui/StatCard';
import { Card, CardBody } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select, TextInput } from '../components/ui/Form';
import { PageContainer } from '../components/ui/PageHeader';
import { toDashboardStats } from '../lib/adapters';
import type { DashboardStats } from '../lib/types';
import { getDashboard, listExams } from '../../services/adminApi';

const POLL_MS = 10000;
type ClassMetric = 'present' | 'ongoing' | 'completed' | 'alerts';
const CLASS_METRICS: { key: ClassMetric; label: string }[] = [
  { key: 'present', label: 'Candidates' },
  { key: 'ongoing', label: 'Writing' },
  { key: 'completed', label: 'Submitted' },
  { key: 'alerts', label: 'Alerts' },
];
const STATUS_COLORS = ['#64748b', '#2563eb', '#16a34a', '#dc2626', '#d97706'];
const dayString = (date: Date) => date.toISOString().slice(0, 10);
const defaultTo = dayString(new Date());
const defaultFromDate = new Date(`${defaultTo}T00:00:00.000Z`);
defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 13);
const defaultFrom = dayString(defaultFromDate);

export function DashboardPage({ onSync }: {
  onSync: (status: 'connected' | 'reconnecting' | 'offline') => void;
}) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [classMetric, setClassMetric] = useState<ClassMetric>('present');
  const [exams, setExams] = useState<{ id: string; exam_name: string; status: string }[]>([]);
  const [examId, setExamId] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const examOptions = [
    { value: '', label: 'Active exam' },
    ...exams.map((exam) => ({ value: exam.id, label: `${exam.exam_name}${exam.status === 'ACTIVE' ? ' (Active)' : ''}` })),
  ];

  useEffect(() => {
    listExams().then((res: any) => setExams(res.exams || [])).catch((err: unknown) => {
      console.error('[DashboardPage] exam filter options failed:', err);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const dashboardRes = await getDashboard({ ...(examId ? { examId } : {}), from, to });
        if (cancelled) return;
        setStats(toDashboardStats(dashboardRes.dashboard));
        setError('');
        setLoading(false);
        onSync('connected');
      } catch (err) {
        console.error('[DashboardPage] refresh failed:', err);
        if (!cancelled) {
          setError('Unable to load the latest dashboard data. Check your connection and retry.');
          setLoading(false);
          onSync('reconnecting');
        }
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
  }, [retry, examId, from, to]);

  if (loading || !stats) {
    return (
      <PageContainer>
        {error ? (
          <div className="mx-auto max-w-lg rounded-xl border border-danger-200 bg-danger-50 p-6 text-center" role="alert">
            <p className="text-sm text-danger-700">{error}</p>
            <Button className="mt-4" onClick={() => { setError(''); setLoading(true); setRetry((value) => value + 1); }}>Retry</Button>
          </div>
        ) : (
          <div className="flex items-center justify-center py-24 text-ink-400 text-sm">Loading dashboard…</div>
        )}
      </PageContainer>
    );
  }

  const statusSlices = [
    { label: 'Pre-exam, online', value: stats.currentlyLoggedIn, color: STATUS_COLORS[0] },
    { label: 'Writing', value: stats.sessionsInProgress, color: STATUS_COLORS[1] },
    { label: 'Submitted', value: stats.sessionsSubmitted, color: STATUS_COLORS[2] },
    { label: 'Blocked', value: stats.sessionsBlocked, color: STATUS_COLORS[3] },
    { label: 'Not started', value: stats.sessionsNotStarted, color: STATUS_COLORS[4] },
  ];
  const statusTotal = statusSlices.reduce((sum, slice) => sum + slice.value, 0);
  let offset = 0;
  const gradient = statusTotal
    ? statusSlices.map((slice) => {
      const start = offset;
      offset += (slice.value / statusTotal) * 100;
      return `${slice.color} ${start}% ${offset}%`;
    }).join(', ')
    : '#e2e8f0';
  const maxClassValue = Math.max(1, ...stats.classBreakdown.map((row) => row[classMetric]));
  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">Dashboard</h1>
        <p className="text-sm text-ink-500 mt-1">Live overview for {stats.selectedExam?.name || 'the active exam'}; the date range applies to submission trends.</p>
      </div>
      {error && <p className="mb-4 rounded-lg border border-warning-200 bg-warning-50 px-4 py-2 text-sm text-warning-700" role="status">Showing the last available data. {error}</p>}

      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-ink-600">Exam<Select value={examId} onChange={setExamId} options={examOptions} className="mt-1 w-full" /></label>
          <label className="text-xs font-medium text-ink-600">Trend from<TextInput type="date" value={from} onChange={setFrom} className="mt-1" /></label>
          <label className="text-xs font-medium text-ink-600">Trend through<TextInput type="date" value={to} onChange={setTo} className="mt-1" /></label>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Eligible Candidates" value={stats.eligibleCandidates} icon={<Users size={20} />} tone="neutral" sublabel="Successful registrations" />
        <StatCard label="Currently Logged In" value={stats.currentlyLoggedIn} icon={<UserCheck size={20} />} tone="accent" sublabel={stats.selectedExam?.status === 'ACTIVE' ? 'Pre-exam presence · active exam' : 'No current presence in selected exam'} />
        <StatCard label="Writing Exam" value={stats.sessionsInProgress} icon={<PenLine size={20} />} tone="brand" sublabel={`${stats.sessionsDisconnected} likely disconnected · recoverable`} />
        <StatCard label="Completed" value={stats.sessionsSubmitted} icon={<CheckCircle2 size={20} />} tone="success" sublabel="Submitted in selected exam" />
        <StatCard label="Not Started" value={stats.sessionsNotStarted} icon={<Clock size={20} />} tone="warning" sublabel="No active attempt" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardBody>
            <h2 className="text-sm font-semibold text-ink-900">Candidate status</h2>
            <p className="mt-1 text-xs text-ink-500">{stats.selectedExam?.status === 'ACTIVE' ? 'Active-exam candidates' : 'Selected-exam attempts'}, grouped by their latest status.</p>
            <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
              <div className="relative h-44 w-44 shrink-0 rounded-full" role="img" aria-label={`Candidate status distribution for ${statusTotal} candidates`} style={{ background: `conic-gradient(${gradient})` }}>
                <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-surface">
                  <span className="text-2xl font-bold tabular-nums text-ink-900">{statusTotal}</span>
                  <span className="text-xs text-ink-500">candidates</span>
                </div>
              </div>
              <ul className="w-full space-y-2 sm:max-w-xs">
                {statusSlices.map((slice) => (
                  <li key={slice.label} className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2 text-ink-600">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
                      {slice.label}
                    </span>
                    <span className="font-semibold tabular-nums text-ink-900">{slice.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink-900">Class activity</h2>
                <p className="mt-1 text-xs text-ink-500">Candidates and attempt activity by class.</p>
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Class activity metric">
                {CLASS_METRICS.map((metric) => (
                  <button key={metric.key} type="button" aria-pressed={classMetric === metric.key} onClick={() => setClassMetric(metric.key)}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${classMetric === metric.key ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}>
                    {metric.label}
                  </button>
                ))}
              </div>
            </div>
            {stats.classBreakdown.length ? (
              <div className="mt-5 space-y-4" role="img" aria-label={`${CLASS_METRICS.find((metric) => metric.key === classMetric)?.label} by class`}>
                {stats.classBreakdown.map((row) => {
                  const value = row[classMetric];
                  return (
                    <div key={row.studentClass}>
                      <div className="mb-1 flex justify-between gap-4 text-xs">
                        <span className="truncate text-ink-600">{row.studentClass}</span>
                        <span className="font-semibold tabular-nums text-ink-900">{value}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-ink-100">
                        <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${(value / maxClassValue) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="py-12 text-center text-sm text-ink-400">No class activity for the active exam yet.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TrendCard title="Daily submissions" points={stats.dailyTrend} metric="submissions" />
        <TrendCard title="Average score trend" points={stats.dailyTrend} metric="averageScorePercent" />
      </div>
    </PageContainer>
  );
}

function TrendCard({ title, points, metric }: {
  title: string;
  points: DashboardStats['dailyTrend'];
  metric: 'submissions' | 'averageScorePercent';
}) {
  const width = 600;
  const height = 190;
  const left = 34;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const numericValues = points.map((point) => metric === 'submissions'
    ? point.submissions
    : point.averageScorePercent ?? 0);
  const maxValue = metric === 'averageScorePercent' ? 100 : Math.max(1, ...numericValues);
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  const coordinate = (index: number, value: number) => ({
    x: left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth),
    y: top + chartHeight - (value / maxValue) * chartHeight,
  });
  const line = points.map((point, index) => {
    const value = point.averageScorePercent;
    return value == null ? null : coordinate(index, value);
  }).filter((point): point is { x: number; y: number } => point !== null);

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        <p className="mt-1 text-xs text-ink-500">{points[0]?.date || '—'} – {points[points.length - 1]?.date || '—'}</p>
        {points.some((point) => metric === 'submissions' ? point.submissions > 0 : point.averageScorePercent != null) ? (
          <svg className="mt-4 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} for selected date range`}>
            {[0, 0.5, 1].map((fraction) => {
              const y = top + chartHeight * fraction;
              return <line key={fraction} x1={left} x2={width - right} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />;
            })}
            {metric === 'submissions' ? points.map((point, index) => {
              const slot = chartWidth / Math.max(points.length, 1);
              const barWidth = Math.max(1, slot * 0.68);
              const { y } = coordinate(index, point.submissions);
              return <rect key={point.date} x={left + index * slot + (slot - barWidth) / 2} y={y} width={barWidth} height={top + chartHeight - y} rx="2" fill="#2563eb">
                <title>{point.date}: {point.submissions} submissions</title>
              </rect>;
            }) : (
              <>
                {line.length > 1 && <polyline points={line.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#16a34a" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
                {points.map((point, index) => point.averageScorePercent == null ? null : (
                  <circle key={point.date} {...coordinate(index, point.averageScorePercent)} r="3" fill="#16a34a">
                    <title>{point.date}: {point.averageScorePercent}% average</title>
                  </circle>
                ))}
              </>
            )}
            {points.map((point, index) => index % labelStep === 0 || index === points.length - 1 ? (
              <text key={point.date} x={coordinate(index, 0).x} y={height - 7} textAnchor="middle" fontSize="10" fill="#64748b">{point.date.slice(5)}</text>
            ) : null)}
          </svg>
        ) : (
          <p className="py-14 text-center text-sm text-ink-400">
            {metric === 'submissions' ? 'No submissions in this date range.' : 'No scored submissions in this date range.'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
