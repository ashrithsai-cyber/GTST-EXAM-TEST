import { useEffect, useState, useCallback } from 'react';
import { Sidebar, Topbar } from './components/layout/Sidebar';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { ExamsPage } from './pages/ExamsPage';
import { QuestionsPage } from './pages/QuestionsPage';
import { VideosPage } from './pages/VideosPage';
import { LiveStudentsPage } from './pages/LiveStudentsPage';
import { ViolationsPage } from './pages/ViolationsPage';
import { CapturedImagesPage } from './pages/CapturedImagesPage';
import { ResultsPage } from './pages/ResultsPage';
import { StudentDataPage } from './pages/StudentDataPage';
import { ExamBrandingPage } from './pages/ExamBrandingPage';
import { SystemRequirementsPage } from './pages/SystemRequirementsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { PAGE_TITLES, type PageKey } from './lib/nav';
import type { CurrentAdmin } from './lib/types';
// Existing, unmodified auth/session layer — the backend's JWT auth and
// RBAC are untouched; nothing about session handling is reimplemented
// here.
import { isLoggedIn, fetchCurrentAdmin, logout } from '../services/authService';
import { onSessionExpired } from '../services/apiClient';

import './index.css';

const COLLAPSE_KEY = 'gtst_admin_v2_sidebar_collapsed';

type SyncState = { status: 'connected' | 'reconnecting' | 'offline'; lastUpdated: string | null };

export default function App() {
  const [admin, setAdmin] = useState<CurrentAdmin | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [active, setActive] = useState<PageKey>('dashboard');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [classContext, setClassContext] = useState<{ classId: string; className: string; examName: string } | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: 'connected', lastUpdated: null });

  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    if (stored !== null) return stored === 'true';
    return typeof window !== 'undefined' && window.innerWidth < 1200;
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    (async () => {
      if (!isLoggedIn()) {
        setCheckingSession(false);
        return;
      }
      try {
        setAdmin(await fetchCurrentAdmin());
      } catch (err) {
        console.error('Unable to verify admin session:', err);
      } finally {
        setCheckingSession(false);
      }
    })();
  }, []);

  useEffect(() => onSessionExpired(() => setAdmin(null)), []);

  const handleLogout = () => {
    if (!window.confirm('Are you sure you want to logout?')) return;
    logout();
    setAdmin(null);
  };

  const navigate = (key: PageKey) => {
    setActive(key);
    setMobileOpen(false);
  };

  const goToClass = (classId: string, className: string, examName: string) => {
    setClassContext({ classId, className, examName });
    setActive('questions');
  };

  const onSync = useCallback((status: SyncState['status']) => {
    setSync({ status, lastUpdated: new Date().toISOString() });
  }, []);

  if (checkingSession) {
    return (
      <div className="newadmin-root min-h-screen flex items-center justify-center bg-ink-50">
        <div className="flex items-center gap-3 text-ink-500">
          <div className="h-5 w-5 border-2 border-ink-200 border-t-brand-600 rounded-full animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      </div>
    );
  }

  if (!admin) {
    return <LoginPage onLoggedIn={setAdmin} />;
  }

  return (
    <div className="newadmin-root flex min-h-screen bg-ink-50">
      <Sidebar
        active={active}
        onNavigate={navigate}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        admin={admin}
        onLogout={handleLogout}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar
          title={PAGE_TITLES[active]}
          onMenuClick={() => setMobileOpen(true)}
          lastUpdated={sync.lastUpdated}
          connectionStatus={sync.status}
        />
        <main className="flex-1 min-w-0">
          {active === 'dashboard' && <DashboardPage onSync={onSync} />}
          {active === 'exams' && <ExamsPage onManageClass={goToClass} />}
          {active === 'questions' && classContext && (
            <QuestionsPage
              classId={classContext.classId}
              className={classContext.className}
              examName={classContext.examName}
              onBack={() => setActive('exams')}
            />
          )}
          {active === 'videos' && <VideosPage />}
          {active === 'live-students' && <LiveStudentsPage onSync={onSync} />}
          {active === 'violations' && <ViolationsPage />}
          {active === 'captured-images' && <CapturedImagesPage />}
          {active === 'results' && <ResultsPage />}
          {active === 'student-data' && <StudentDataPage />}
          {active === 'exam-branding' && <ExamBrandingPage />}
          {active === 'system-requirements' && <SystemRequirementsPage />}
          {active === 'admin-users' && <AdminUsersPage admin={admin} />}
          {active === 'audit-logs' && <AuditLogsPage />}
        </main>
      </div>
    </div>
  );
}
