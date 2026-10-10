import { type ReactNode } from 'react';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 tracking-tight">{title}</h1>
        {description && <p className="text-sm text-ink-500 mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  // Full-width: content stretches to fill the available space next to the
  // sidebar (no max-width cap / centering), keeping responsive side padding
  // so it never jams against the viewport edge.
  return <div className="px-4 sm:px-6 lg:px-8 py-6 w-full animate-slide-up">{children}</div>;
}
