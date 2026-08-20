/**
 * レッスン入室最小間隔（F1、ADR-027 ケースG）の gap 判定ロジック
 * Firestore/InMemory DataSource 実装と、read-only プレビュー（previewEntryCooldown）で共通利用する。
 */

import type { LessonSession } from "../types/entities.js";

export interface LatestCourseExit {
  exitMs: number;
  lessonId: string;
}

/**
 * 同一コース内のセッション群から、直近の「終端（exitAt !== null）」セッションを探す。
 * synthetic session（換算タイムスタンプ）・exitAt 欠落・パース不能・未来時刻（now 超過）は除外する。
 */
export function findLatestCourseExit(
  sessions: readonly Pick<LessonSession, "lessonId" | "exitAt" | "isSynthetic">[],
  nowMs: number
): LatestCourseExit | null {
  let latestExitMs = -Infinity;
  let latestLessonId: string | null = null;
  for (const s of sessions) {
    if (s.isSynthetic) continue;
    if (!s.exitAt) continue;
    const exitMs = new Date(s.exitAt).getTime();
    if (Number.isNaN(exitMs) || exitMs > nowMs) continue;
    if (exitMs > latestExitMs) {
      latestExitMs = exitMs;
      latestLessonId = s.lessonId;
    }
  }
  return latestLessonId === null ? null : { exitMs: latestExitMs, lessonId: latestLessonId };
}

export interface EntryGapDecision {
  blocked: boolean;
  retryAfterMs?: number;
  nextEntryAllowedAt?: string;
  previousLessonId?: string;
}

/**
 * 同一コース内セッション群 + 入室先レッスンIDから gap 判定を行う。
 * 同一レッスンへの再入室は免除（ADR-027 正規動線）、gap が gapMs 未満ならブロック。
 */
export function evaluateEntryGap(
  sessions: readonly Pick<LessonSession, "lessonId" | "exitAt" | "isSynthetic">[],
  requestedLessonId: string,
  nowMs: number,
  gapMs: number
): EntryGapDecision {
  const latest = findLatestCourseExit(sessions, nowMs);
  if (!latest || latest.lessonId === requestedLessonId) return { blocked: false };

  const gap = nowMs - latest.exitMs;
  if (gap >= gapMs) return { blocked: false };

  const nextEntryAllowedMs = latest.exitMs + gapMs;
  return {
    blocked: true,
    retryAfterMs: nextEntryAllowedMs - nowMs,
    nextEntryAllowedAt: new Date(nextEntryAllowedMs).toISOString(),
    previousLessonId: latest.lessonId,
  };
}
