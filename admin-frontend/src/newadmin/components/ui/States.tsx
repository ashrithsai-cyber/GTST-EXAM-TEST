import { type ReactNode } from 'react';

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 text-ink-400 mb-3">{icon}</div>
      <h3 className="text-sm font-semibold text-ink-700">{title}</h3>
      {description && <p className="text-sm text-ink-500 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-3 text-ink-500">
        <div className="h-5 w-5 border-2 border-ink-200 border-t-brand-600 rounded-full animate-spin" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}
