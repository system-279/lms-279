/**
 * レッスンセッション（出席管理）サービス
 * 入室打刻・退室打刻・一時停止リセット・2時間制限の管理
 */

import type { DataSource } from "../datasource/interface.js";
import type { LessonSession, SessionExitReason } from "../types/entities.js";
import { updateCourseProgress } from "./progress.js";

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
  const now = new Date();
  const deadlineAt = new Date(now.getTime() + SESSION_DURATION_MS);

  return ds.getOrCreateLessonSession(userId, lessonId, {
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
 * セッションを強制退室にし、レッスンの学習データを完全リセットする。
 * リセット対象: video_analytics, video_events, quiz_attempts, user_progress
 * （2時間以内に1セッションで完了する要件のため）
 */
export async function forceExitSession(
  ds: DataSource,
  sessionId: string,
  reason: SessionExitReason
): Promise<LessonSession> {
  const session = await ds.getLessonSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const updated = await ds.updateLessonSession(sessionId, {
    status: "force_exited",
    exitAt: new Date().toISOString(),
    exitReason: reason,
  });

  // 動画完了済みセッションでは学習データをリセットしない。
  // HTML5 videoのendedはpause状態を伴うため、完了後のpauseタイムアウトや
  // ページリロード等でデータが全消去されるのを防止する。
  if (!session.sessionVideoCompleted) {
    await ds.resetLessonDataForUser(session.userId, session.lessonId, session.courseId);
    await updateCourseProgress(ds, session.userId, session.courseId);
  }

  return updated!;
}

/**
 * セッションを放棄状態に更新（ブラウザ終了時）
 * forceExitSessionと異なり、学習データのリセットは行わない。
 * 放棄後、同一ユーザーは同じレッスンで新規セッションを作成可能。
 */
export async function abandonSession(
  ds: DataSource,
  sessionId: string
): Promise<LessonSession> {
  // TOCTOU対策: 更新前にstatusを再確認（テスト送信による完了との競合防止）
  const session = await ds.getLessonSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (session.status !== "active") {
    return session;
  }

  const updated = await ds.updateLessonSession(sessionId, {
    status: "abandoned",
    exitAt: new Date().toISOString(),
    exitReason: "browser_close",
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
