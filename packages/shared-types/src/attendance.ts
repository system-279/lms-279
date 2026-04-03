/**
 * 出席管理API レスポンスDTO
 * ソース:
 *   - admin: services/api/src/routes/shared/analytics.ts (buildAttendanceRecords)
 *   - super: services/api/src/routes/super-admin.ts (attendance-report)
 */

import type { LessonSessionStatus, SessionExitReason } from "./enums.js";

// ============================================================
// 管理者向け出席
// GET /admin/analytics/attendance/courses/:courseId
// ============================================================

export interface AdminAttendanceRecord {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  lessonId: string;
  lessonTitle: string;
  status: LessonSessionStatus;
  entryAt: string;
  exitAt: string | null;
  exitReason: SessionExitReason | null;
  durationMin: number;
}

export interface AdminAttendanceResponse {
  courseId: string;
  courseName: string;
  totalSessions: number;
  completedSessions: number;
  forceExitedSessions: number;
  records: AdminAttendanceRecord[];
}

// ============================================================
// スーパー管理者向け出席レポート
// GET /super/tenants/:tenantId/attendance-report
// ============================================================

export interface SuperAttendanceRecord {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  courseId: string;
  courseName: string;
  lessonId: string;
  lessonTitle: string;
  date: string | null;
  entryAt: string | null;
  exitAt: string | null;
  exitReason: string | null;
  status: string;
  quizAttemptId: string | null;
  quizScore: number | null;
  quizPassed: boolean | null;
  quizSubmittedAt: string | null;
}

export interface SuperAttendanceResponse {
  tenantId: string;
  tenantName: string;
  records: SuperAttendanceRecord[];
  totalRecords: number;
}
