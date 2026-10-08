import { type ReactNode } from 'react';
import { Badge } from './Badge';

export function StatCard({ label, value, icon, tone = 'brand', trend, sublabel }: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
  trend?: { value: string; positive: boolean };
  sublabel?: ReactNode;
}) {
  const toneClasses: Record<string, string> = {
    brand: 'bg-brand-50 text-brand-600',
    success: 'bg-success-50 text-success-600',
    warning: 'bg-warning-50 text-warning-600',
    danger: 'bg-danger-50 text-danger-600',
    accent: 'bg-accent-50 text-accent-600',
    neutral: 'bg-ink-100 text-ink-500',
  };
  return (
    <div className="bg-surface rounded-xl border border-ink-200 shadow-card p-5 transition-shadow hover:shadow-card-hover">
      <div className="flex items-start justify-between">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${toneClasses[tone]}`}>{icon}</div>
        {trend && (
          <Badge tone={trend.positive ? 'success' : 'danger'}>
            {trend.positive ? '↑' : '↓'} {trend.value}
          </Badge>
        )}
      </div>
      <div className="mt-4">
        <p className="text-2xl font-bold text-ink-900 tabular-nums">{value}</p>
        <p className="text-sm font-medium text-ink-600 mt-0.5">{label}</p>
        {sublabel && <p className="text-xs text-ink-400 mt-1">{sublabel}</p>}
      </div>
    </div>
  );
}
