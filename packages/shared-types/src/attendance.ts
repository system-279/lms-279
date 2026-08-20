/**
 * 出席管理API レスポンスDTO
 * ソース:
 *   - admin: services/api/src/routes/shared/analytics.ts (buildAttendanceRecords)
 *   - super: services/api/src/routes/super-admin.ts (attendance-report)
 */

import type { LessonSessionStatus, SessionExitReason } from "./enums.js";

// ============================================================
// 出席記録の異常検知（F2、ADR-027）
// ============================================================

/**
 * 出席記録の異常種別。
 * - overlap_previous: 同一ユーザーの他セッションと入退室時刻が重複している（後発の行に付与）
 * - negative_duration: exitAt が entryAt より前（データ不整合）
 * - stale_active: active のまま SESSION_DURATION_MS を超えて放置されている
 */
export type SessionAnomalyType = "overlap_previous" | "negative_duration" | "stale_active";

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
  anomalies?: SessionAnomalyType[];
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
  isSynthetic: boolean;
  /**
   * 編集前の値の immutable snapshot（初回 PATCH 時に記録、以降不変）。Issue #556。
   * フィールドが存在しない場合 (`undefined`)、当該レコードは未編集または Phase 3 follow-up 投入前データ。
   */
  original?: {
    entryAt: string | null;
    exitAt: string | null;
    quizScore: number | null;
    quizPassed: boolean | null;
  };
  /** 最後の編集時刻 (ISO8601)。未編集の場合 `undefined`。Issue #556。 */
  editedAt?: string;
  anomalies?: SessionAnomalyType[];
}

export interface SuperAttendanceResponse {
  tenantId: string;
  tenantName: string;
  records: SuperAttendanceRecord[];
  totalRecords: number;
}
