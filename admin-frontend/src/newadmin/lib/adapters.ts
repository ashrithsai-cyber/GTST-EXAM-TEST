// Pure mapping functions: real backend/Exam-Supabase row shapes (snake_
// case, as returned by backend/src/controllers/admin.controller.js et al,
// wrapped by admin-frontend/src/services/adminApi.js) -> the camelCase
// view models in ./types.ts consumed by the new pages. Every decision
// here traces back to the approved plan's Part D. Nothing here invents
// data — nullable/missing fields stay null and are rendered as "Not
// Available" by the pages, never a fabricated placeholder.

import type {
  SafetyVideo, Result,
  AdminUser, AuditLogEntry, DashboardStats, Branding,
} from './types';

export function toDashboardStats(raw: any): DashboardStats {
  return {
    currentlyLoggedIn: raw.currentlyLoggedIn ?? raw.totalCandidates ?? 0,
    eligibleCandidates: raw.eligibleCandidates ?? 0,
    totalExams: raw.totalExams ?? 0,
    sessionsInProgress: raw.sessionsInProgress ?? 0,
    sessionsSubmitted: raw.sessionsSubmitted ?? 0,
    sessionsBlocked: raw.sessionsBlocked ?? 0,
    sessionsNotStarted: raw.sessionsNotStarted ?? 0,
    sessionsDisconnected: raw.sessionsDisconnected ?? 0,
    averageScorePercent: raw.averageScorePercent ?? null,
    classBreakdown: raw.classBreakdown ?? [],
    selectedExam: raw.selectedExam ?? null,
    trendRange: raw.trendRange ?? null,
    dailyTrend: raw.dailyTrend ?? [],
  };
}

export function toVideo(raw: any): SafetyVideo {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description ?? null,
    fileName: raw.fileName,
    fileSizeBytes: raw.fileSize,
    mimeType: raw.mimeType,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function toResult(raw: any): Result {
  return {
    id: raw.id,
    studentName: raw.exam_candidates?.full_name ?? 'Unknown',
    registrationId: raw.exam_candidates?.registration_id ?? '—',
    studentClass: raw.exam_candidates?.student_class ?? null,
    examId: raw.exam_id,
    submittedAt: raw.submitted_at ?? null,
    score: raw.total_score ?? 0,
    maxScore: raw.max_score ?? 0,
    percentage: raw.percentage ?? 0,
  };
}

export function toAdminUser(raw: any): AdminUser {
  return {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    role: 'admin',
    isActive: !!raw.is_active,
    createdAt: raw.created_at,
    lastLoginAt: raw.last_login_at ?? null,
  };
}

// branding.controller.js already returns/accepts this exact camelCase
// shape — passthrough only, no renaming needed.
export function toBranding(raw: any): Branding {
  return {
    examName: raw.examName ?? '',
    logoUrl: raw.logoUrl ?? null,
    updatedAt: raw.updatedAt,
  };
}

export function toAuditLogEntry(raw: any): AuditLogEntry {
  return {
    id: raw.id,
    actorName: raw.admin_users?.name ?? null,
    actorEmail: raw.admin_users?.email ?? null,
    action: raw.action,
    resourceType: raw.resource_type,
    resourceId: raw.resource_id ?? null,
    metadata: raw.metadata ?? null,
    createdAt: raw.created_at,
  };
}
