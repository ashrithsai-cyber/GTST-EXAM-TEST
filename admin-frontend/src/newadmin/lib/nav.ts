import {
  LayoutDashboard, FileText, Video, Users, ShieldAlert,
  BarChart3, IdCard, Image, UserCog, ScrollText, SlidersHorizontal, Camera, type LucideIcon,
} from 'lucide-react';

export type PageKey =
  | 'dashboard'
  | 'exams'
  | 'questions'
  | 'videos'
  | 'live-students'
  | 'violations'
  | 'captured-images'
  | 'results'
  | 'student-data'
  | 'exam-branding'
  | 'system-requirements'
  | 'admin-users'
  | 'audit-logs';

export const PAGE_TITLES: Record<PageKey, string> = {
  dashboard: 'Dashboard',
  exams: 'Exams',
  questions: 'Questions',
  videos: 'Videos',
  'live-students': 'Live Students',
  violations: 'Violations',
  'captured-images': 'Captured Images',
  results: 'Results',
  'student-data': 'Student Data',
  'exam-branding': 'Exam Branding',
  'system-requirements': 'System Requirements',
  'admin-users': 'Admin Management',
  'audit-logs': 'Audit Logs',
};

export type NavGroup = {
  section: string;
  items: { key: PageKey; label: string; icon: LucideIcon }[];
};

// Matches the sidebar structure from the original spec this admin
// dashboard was rebuilt around: Dashboard; Exam Management (Exams,
// Videos); Live Monitoring (Live Students, Violations); Results;
// Settings (Student Data, Exam Branding, Admin Management, Audit Logs).
// Questions ('questions' PageKey) has no standalone sidebar entry — it's
// only reachable by drilling into a class from the Exams page, since a
// question bank is always scoped to one class now, never viewed flat.
export const NAV: NavGroup[] = [
  { section: '', items: [{ key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    section: 'Exam Management',
    items: [
      { key: 'exams', label: 'Exams', icon: FileText },
      { key: 'videos', label: 'Videos', icon: Video },
    ],
  },
  {
    section: 'Live Monitoring',
    items: [
      { key: 'live-students', label: 'Live Students', icon: Users },
      { key: 'violations', label: 'Violations', icon: ShieldAlert },
      { key: 'captured-images', label: 'Captured Images', icon: Camera },
    ],
  },
  { section: 'Results', items: [{ key: 'results', label: 'Results', icon: BarChart3 }] },
  {
    section: 'Settings',
    items: [
      { key: 'student-data', label: 'Student Data', icon: IdCard },
      { key: 'exam-branding', label: 'Exam Branding', icon: Image },
      { key: 'system-requirements', label: 'System Requirements', icon: SlidersHorizontal },
      { key: 'admin-users', label: 'Admin Management', icon: UserCog },
      { key: 'audit-logs', label: 'Audit Logs', icon: ScrollText },
    ],
  },
];
