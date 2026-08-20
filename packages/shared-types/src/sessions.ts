/**
 * レッスンセッションAPI レスポンスDTO
 * ソース: services/api/src/routes/shared/lesson-sessions.ts (formatSession)
 */

import type { LessonSessionStatus, SessionExitReason } from "./enums.js";

export interface LessonSessionResponse {
  id: string;
  sessionToken: string;
  status: LessonSessionStatus;
  entryAt: string;
  exitAt: string | null;
  exitReason: SessionExitReason | null;
  deadlineAt: string;
  remainingMs: number;
  sessionVideoCompleted: boolean;
}

// ============================================================
// 入室最小間隔（F1、ADR-027 ケースG）
// ============================================================

/**
 * 異なるレッスンへの入室ギャップ判定結果。
 * `blocked=false` の場合、他のフィールドは undefined。
 */
export interface LessonEntryCooldown {
  blocked: boolean;
  /** ブロック解除までの残りミリ秒（blocked=true 時のみ） */
  retryAfterMs?: number;
  /** 次に入室可能になる時刻（ISO 8601、blocked=true 時のみ） */
  nextEntryAllowedAt?: string;
  /** 直前に退室したレッスンID（blocked=true 時のみ） */
  previousLessonId?: string;
}

/**
 * GET /lesson-sessions/active のレスポンス。
 * `entryCooldown`/`entryGapMs` はクエリ対象レッスンについて事前ゲート表示用に付与される
 * （session の有無に関わらず計算される。session が既にあれば常に blocked=false）。
 */
export interface ActiveLessonSessionResponse {
  session: LessonSessionResponse | null;
  entryCooldown?: LessonEntryCooldown;
  /** 表示文言の動的生成用（`LESSON_ENTRY_GAP_MS` の値、ミリ秒） */
  entryGapMs?: number;
}

/**
 * POST /lesson-sessions が 409 `entry_too_soon` を返す際のエラー詳細。
 */
export interface LessonEntryTooSoonDetails {
  retryAfterMs: number;
  nextEntryAllowedAt: string;
  previousLessonId: string;
}
