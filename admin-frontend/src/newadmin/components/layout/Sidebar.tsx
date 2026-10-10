import { useState, type ReactNode } from 'react';
import { ChevronLeft, GraduationCap, LogOut } from 'lucide-react';
import { NAV, type PageKey } from '../../lib/nav';
import type { CurrentAdmin } from '../../lib/types';

export function Sidebar({ active, onNavigate, collapsed, onToggleCollapse, mobileOpen, onCloseMobile, admin, onLogout }: {
  active: PageKey;
  onNavigate: (key: PageKey) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  admin: CurrentAdmin;
  onLogout: () => void;
}) {
  const initials = admin.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden" onClick={onCloseMobile} />}
      <aside
        className={`fixed lg:sticky top-0 z-40 h-screen shrink-0 bg-surface-sidebar text-ink-600 flex flex-col border-r border-ink-200 transition-all duration-300 ${
          collapsed ? 'w-[68px]' : 'w-64'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className="flex items-center gap-3 px-4 h-[60px] shrink-0 border-b border-ink-200">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
            <GraduationCap size={17} />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="font-mono text-[13px] font-semibold text-ink-900 tracking-wide truncate">GTST+ ADMIN</p>
              <p className="font-mono text-[9.5px] text-ink-400 tracking-[0.12em] truncate">EXAMINATION CONSOLE</p>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-thin px-2.5 py-4 space-y-5">
          {NAV.map((group) => {
            const items = group.items;
            if (items.length === 0) return null;
            return (
              <div key={group.section || 'main'}>
                {group.section && !collapsed && (
                  <p className="font-mono px-3 mb-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-500">{group.section}</p>
                )}
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = item.icon;
                    const isActive = active === item.key;
                    return (
                      <button
                        key={item.key}
                        onClick={() => { onNavigate(item.key); onCloseMobile(); }}
                        title={collapsed ? item.label : undefined}
                        className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                          isActive
                            ? 'bg-brand-50 text-brand-700 shadow-[inset_2px_0_0_theme(colors.brand.600)]'
                            : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900'
                        } ${collapsed ? 'justify-center' : ''}`}
                      >
                        <Icon size={17} className="shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 px-2.5 py-3 border-t border-ink-200 space-y-1">
          {!collapsed && (
            <div className="flex items-center gap-2.5 px-2 py-1.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 font-mono text-xs font-semibold">{initials}</div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink-800 truncate">{admin.name}</p>
                <p className="font-mono text-[10px] text-ink-400 tracking-wider truncate uppercase">{admin.role}</p>
              </div>
            </div>
          )}
          <button
            onClick={onLogout}
            title={collapsed ? 'Logout' : undefined}
            className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-500 hover:bg-danger-50 hover:text-danger-600 transition-colors ${collapsed ? 'justify-center' : ''}`}
          >
            <LogOut size={17} className="shrink-0" />
            {!collapsed && <span>Logout</span>}
          </button>
          <button
            onClick={onToggleCollapse}
            className="hidden lg:flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-400 hover:bg-ink-100 hover:text-ink-800 transition-colors"
          >
            <ChevronLeft size={17} className={`shrink-0 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

export function SidebarTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="lg:hidden inline-flex items-center justify-center rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-800 transition-colors">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z" /></svg>
    </button>
  );
}

export function Topbar({ title, children, onMenuClick, lastUpdated, connectionStatus }: {
  title: string;
  children?: ReactNode;
  onMenuClick: () => void;
  lastUpdated: string | null;
  connectionStatus: 'connected' | 'reconnecting' | 'offline';
}) {
  const [now] = useState(new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase());
  const connMeta = {
    connected: { label: 'LIVE', wrap: 'bg-success-50 ring-success-200', dot: 'bg-success-500', text: 'text-success-700' },
    reconnecting: { label: 'RECONNECTING', wrap: 'bg-warning-50 ring-warning-200', dot: 'bg-warning-500 animate-pulse-soft', text: 'text-warning-700' },
    offline: { label: 'OFFLINE', wrap: 'bg-danger-50 ring-danger-200', dot: 'bg-danger-500', text: 'text-danger-700' },
  }[connectionStatus];

  return (
    <header className="sticky top-0 z-20 bg-surface border-b border-ink-200 h-[60px] flex items-center gap-3 px-4 sm:px-6">
      <SidebarTrigger onClick={onMenuClick} />
      <div className="min-w-0 flex-1 flex items-baseline gap-3">
        <h2 className="text-base font-semibold text-ink-900 truncate">{title}</h2>
        <p className="font-mono text-[11px] text-ink-400 tracking-wide hidden sm:block whitespace-nowrap">{now}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {children}
        <div className={`hidden sm:flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ring-inset ${connMeta.wrap}`}>
          <span className={`h-2 w-2 rounded-full ${connMeta.dot}`} />
          <span className={`font-mono text-[11px] font-semibold tracking-wide ${connMeta.text}`}>{connMeta.label}</span>
          {lastUpdated && (
            <span className="font-mono text-[11px] text-ink-400">· {new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          )}
        </div>
      </div>
    </header>
  );
}
