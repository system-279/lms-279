/**
 * レッスンセッション（出席管理）サービス
 * 入室打刻・退室打刻・一時停止リセット・セッション制限時間の管理
 */

import type { DataSource } from "../datasource/interface.js";
import type { LessonSession, Quiz, QuizAttempt, SessionExitReason } from "../types/entities.js";
import { parsePositiveDurationMs } from "../utils/env-config.js";
import { logger } from "../utils/logger.js";
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
 *
 * timed_out が maxAttempts カウントから除外される責務は createQuizAttemptAtomic
 * （services/quiz-attempt-utils.ts の countEffectiveAttempts）が持つため、
 * 救済による受験回数消費はない。
 *
 * 並行 PATCH 提出との競合対策として transitionQuizAttemptToTimedOut の条件付き更新
 * （in_progress 状態のみ遷移）を使用。submitted attempt を timed_out で上書きしない。
 *
 * 失敗ハンドリング: 本ヘルパー内のエラーは呼び出し元（forceExitSession / abandonSession）に
 * propagate せず、session 終了処理を継続する。cleanup 失敗の検知は Cloud Logging の
 * `errorType=cleanup_in_progress_attempts_*` フィルタで行うこと。
 * 個別 attempt の cleanup 失敗 = 該当 user の次回テスト開始失敗を意味するため要監視。
 */
async function cleanupInProgressAttempts(
  ds: DataSource,
  userId: string,
  lessonId: string
): Promise<void> {
  let quiz: Quiz | null;
  try {
    quiz = await ds.getQuizByLessonId(lessonId);
  } catch (err) {
    logger.error("cleanupInProgressAttempts: failed to load quiz", {
      errorType: "cleanup_in_progress_attempts_quiz_load_failed",
      userId,
      lessonId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }
  if (!quiz) {
    // lesson に quiz が紐づかないケース（quiz 削除済み + 過去の in_progress 残留など）は
    // 正常運用では起きにくいため warn で観測可能化
    logger.warn("cleanupInProgressAttempts: quiz not found for lesson; skipping", {
      errorType: "cleanup_in_progress_attempts_quiz_missing",
      userId,
      lessonId,
    });
    return;
  }

  let attempts: QuizAttempt[];
  try {
    attempts = await ds.getQuizAttempts({ quizId: quiz.id, userId });
  } catch (err) {
    logger.error("cleanupInProgressAttempts: failed to load attempts", {
      errorType: "cleanup_in_progress_attempts_load_failed",
      userId,
      lessonId,
      quizId: quiz.id,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }

  let cleaned = 0;
  let failed = 0;
  let skipped = 0;
  const failedAttemptIds: string[] = [];

  for (const attempt of attempts) {
    if (attempt.status !== "in_progress") continue;
    try {
      const result = await ds.transitionQuizAttemptToTimedOut(attempt.id);
      if (result.transitioned) {
        cleaned++;
      } else {
        // 並行 PATCH 提出で submitted に遷移済 / 別経路で timed_out 化済の場合
        skipped++;
      }
    } catch (err) {
      // 部分救済 > 全停止: 1件失敗しても他の attempt の救済は続行
      failed++;
      failedAttemptIds.push(attempt.id);
      logger.error("cleanupInProgressAttempts: failed to transition attempt", {
        errorType: "cleanup_in_progress_attempts_individual_failed",
        userId,
        lessonId,
        quizId: quiz.id,
        attemptId: attempt.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  if (failed > 0) {
    // ユーザーの次回テスト開始失敗を意味するため別 errorType でアラート可能に
    logger.error("cleanupInProgressAttempts: partial failure", {
      errorType: "cleanup_in_progress_attempts_partial_failure",
      userId,
      lessonId,
      quizId: quiz.id,
      cleaned,
      failed,
      skipped,
      failedAttemptIds,
    });
  } else if (cleaned > 0) {
    logger.info("cleanupInProgressAttempts: success", {
      eventType: "cleanup_in_progress_attempts_success",
      userId,
      lessonId,
      quizId: quiz.id,
      cleaned,
      skipped,
    });
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
  if (!updated) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // 動画完了済みセッションでは学習データをリセットしない。
  // HTML5 videoのendedはpause状態を伴うため、完了後のpauseタイムアウトや
  // ページリロード等でデータが全消去されるのを防止する。
  if (session.sessionVideoCompleted) {
    // Issue #422: reset スキップ経路では attempt が残るため明示的に終端化
    await cleanupInProgressAttempts(ds, session.userId, session.lessonId);
  } else {
    // reset 経路: resetLessonDataForUser が quiz_attempts を全削除するため cleanup 不要
    await ds.resetLessonDataForUser(session.userId, session.lessonId, session.courseId);
    await updateCourseProgress(ds, session.userId, session.courseId);
  }

  return updated;
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
