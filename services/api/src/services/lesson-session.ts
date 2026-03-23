/**
 * レッスンセッション（出席管理）サービス
 * 入室打刻・退室打刻・一時停止リセット・2時間制限の管理
 */

import type { DataSource } from "../datasource/interface.js";
import type { LessonSession, SessionExitReason } from "../types/entities.js";

const SESSION_DURATION_MS = 2 * 60 * 60 * 1000; // 2時間

/**
 * 新しいレッスンセッションを作成（入室打刻）
 */
export async function createSession(
  ds: DataSource,
  userId: string,
  lessonId: string,
  courseId: string,
  videoId: string,
  sessionToken: string
): Promise<LessonSession> {
  const now = new Date();
  const deadlineAt = new Date(now.getTime() + SESSION_DURATION_MS);

  return ds.createLessonSession({
    userId,
    lessonId,
    courseId,
    videoId,
    sessionToken,
    status: "active",
    entryAt: now.toISOString(),
    exitAt: null,
    exitReason: null,
    deadlineAt: deadlineAt.toISOString(),
    pauseStartedAt: null,
    longestPauseSec: 0,
    sessionVideoCompleted: false,
    quizAttemptId: null,
  });
}

/**
 * アクティブセッションを取得、なければ作成
 */
export async function getOrCreateSession(
  ds: DataSource,
  userId: string,
  lessonId: string,
  courseId: string,
  videoId: string,
  sessionToken: string
): Promise<{ session: LessonSession; created: boolean }> {
  const existing = await ds.getActiveLessonSession(userId, lessonId);
  if (existing) {
    return { session: existing, created: false };
  }
  const session = await createSession(ds, userId, lessonId, courseId, videoId, sessionToken);
  return { session, created: true };
}

/**
 * セッションを強制退室にする
 */
export async function forceExitSession(
  ds: DataSource,
  sessionId: string,
  reason: SessionExitReason
): Promise<LessonSession> {
  const updated = await ds.updateLessonSession(sessionId, {
    status: "force_exited",
    exitAt: new Date().toISOString(),
    exitReason: reason,
  });
  if (!updated) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return updated;
}

/**
 * セッションをテスト送信で完了（退室打刻）
 */
export async function completeSession(
  ds: DataSource,
  sessionId: string,
  quizAttemptId: string
): Promise<LessonSession> {
  const updated = await ds.updateLessonSession(sessionId, {
    status: "completed",
    exitAt: new Date().toISOString(),
    exitReason: "quiz_submitted",
    quizAttemptId,
  });
  if (!updated) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return updated;
}

/**
 * セッションが2時間制限内かチェック
 */
export function validateSessionDeadline(session: LessonSession): boolean {
  return new Date(session.deadlineAt).getTime() > Date.now();
}

/**
 * 期限切れのactiveセッションを自動で強制退室
 * ブラウザクラッシュ後の復帰時等に使用
 */
export async function handleStaleSession(
  ds: DataSource,
  session: LessonSession
): Promise<LessonSession> {
  if (session.status !== "active") return session;
  if (validateSessionDeadline(session)) return session;

  return forceExitSession(ds, session.id, "time_limit");
}
