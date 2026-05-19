/**
 * レッスンセッション（出席管理）サービス
 * 入室打刻・退室打刻・一時停止リセット・セッション制限時間の管理
 */

import type { DataSource } from "../datasource/interface.js";
import type { LessonSession, SessionExitReason } from "../types/entities.js";
import { parsePositiveDurationMs } from "../utils/env-config.js";
import { updateCourseProgress } from "./progress.js";

// セッション制限時間（ミリ秒、正の整数）。env var SESSION_DURATION_MS で上書き可、デフォルト 2 時間、本番運用は 3 時間（10800000）。
// 不正値（NaN / 0 以下 / 非整数 / 単位付き文字列など）は logger.error 出力後デフォルトにフォールバック。
// 動画 60-80 分 + テスト解答時間で詰まる現場運用に対応するため env で延長可能（ADR-027 / PR #407 参照）。
export const SESSION_DURATION_MS = parsePositiveDurationMs(
  process.env.SESSION_DURATION_MS,
  2 * 60 * 60 * 1000,
  "SESSION_DURATION_MS"
);

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
 * セッション終了時、同一ユーザー・同一レッスンの in_progress quiz_attempt を
 * timed_out に遷移させ、再受験を可能にする（Issue #422）。
 *
 * sessionVideoCompleted=true で resetLessonDataForUser がスキップされる経路でも
 * attempt のロックが残らないよう、session 終了処理と独立に attempt を終端化する。
 * answers は監査証跡として保持し、score/isPassed は null のまま、submittedAt のみ now を入れる。
 * timed_out は maxAttempts カウントから除外されるため、救済による受験回数消費はない。
 */
async function cleanupInProgressAttempts(
  ds: DataSource,
  userId: string,
  lessonId: string
): Promise<void> {
  let quiz;
  try {
    quiz = await ds.getQuizByLessonId(lessonId);
  } catch (err) {
    console.error(`cleanupInProgressAttempts: failed to load quiz for lesson ${lessonId}:`, err);
    return;
  }
  if (!quiz) return;

  let attempts;
  try {
    attempts = await ds.getQuizAttempts({ quizId: quiz.id, userId });
  } catch (err) {
    console.error(`cleanupInProgressAttempts: failed to load attempts for quiz ${quiz.id}:`, err);
    return;
  }

  const now = new Date().toISOString();
  for (const attempt of attempts) {
    if (attempt.status !== "in_progress") continue;
    try {
      await ds.updateQuizAttempt(attempt.id, {
        status: "timed_out",
        submittedAt: now,
      });
    } catch (err) {
      // 1件失敗しても他は続行
      console.error(`cleanupInProgressAttempts: failed to cleanup attempt ${attempt.id}:`, err);
    }
  }
}

/**
 * セッションを強制退室にし、レッスンの学習データを完全リセットする。
 * リセット対象: video_analytics, video_events, quiz_attempts, user_progress
 * （1 セッション内で動画視聴→テスト送信まで完了させる要件のため。セッション上限は SESSION_DURATION_MS）
 *
 * Issue #422: in_progress な quiz_attempt のロック解除も実施する（reset スキップ経路の救済）。
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

  // attempt ロック解除（reset スキップ時の救済 / reset 実施時は noop）
  await cleanupInProgressAttempts(ds, session.userId, session.lessonId);

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

  // Issue #422: ブラウザクローズ後も in_progress attempt が残ると次回テスト開始不能になるため終端化
  await cleanupInProgressAttempts(ds, session.userId, session.lessonId);

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
 * セッションが deadlineAt（= entryAt + SESSION_DURATION_MS）を過ぎていないかチェック
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
