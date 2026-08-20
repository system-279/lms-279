/**
 * レッスンセッション（出席管理）サービス
 * 入室打刻・退室打刻・一時停止リセット・セッション制限時間の管理
 */

import type { DataSource, SessionWithGapCheckResult } from "../datasource/interface.js";
import type { LessonSession, Quiz, QuizAttempt, SessionExitReason } from "../types/entities.js";
import { parseNonNegativeDurationMs, parsePositiveDurationMs } from "../utils/env-config.js";
import { logger } from "../utils/logger.js";
import { withTransientRetry } from "../utils/with-transient-retry.js";
import { evaluateEntryGap } from "./lesson-entry-gap.js";
import { updateCourseProgress } from "./progress.js";

// セッション制限時間（ミリ秒、正の整数）。env var SESSION_DURATION_MS で上書き可、デフォルト 2 時間、本番運用は 3 時間（10800000）。
// 不正値（NaN / 0 以下 / 非整数 / 単位付き文字列など）は logger.error 出力後デフォルトにフォールバック。
// 動画 60-80 分 + テスト解答時間で詰まる現場運用に対応するため env で延長可能（ADR-027 / PR #407 参照）。
export const SESSION_DURATION_MS = parsePositiveDurationMs(
  process.env.SESSION_DURATION_MS,
  2 * 60 * 60 * 1000,
  "SESSION_DURATION_MS"
);

// 入室最小間隔（ミリ秒）。異なるレッスンへの入室を、直前レッスンの退室から本間隔だけブロックする
// （F1、ADR-027 ケースG）。env var LESSON_ENTRY_GAP_MS で上書き可、デフォルト 60000ms（1分）。
// `0` は kill switch（無効化、旧挙動）として明示的に許容する。
export const LESSON_ENTRY_GAP_MS = parseNonNegativeDurationMs(
  process.env.LESSON_ENTRY_GAP_MS,
  60000,
  "LESSON_ENTRY_GAP_MS"
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
 * F1: 入室最小間隔チェック付きセッション取得/作成（ADR-027 ケースG）。
 *
 * `LESSON_ENTRY_GAP_MS<=0`（kill switch）の場合は判定自体を省略し、
 * 従来の `getOrCreateSession` と同じ挙動（無条件許可）にフォールバックする
 * （kill switch 有効時に不要なトランザクションコストをかけないため）。
 *
 * トランザクション自体が失敗した場合は fail-open（入室許可）する。理由:
 * 本機能は不正防止ではなくログ品質向上が目的であり、transient Firestore エラーで
 * 受講者を締め出すのは本末転倒（`hasPersistentVideoCompletion` と同じ safe-by-default 思想）。
 */
export async function getOrCreateSessionWithGapCheck(
  ds: DataSource,
  userId: string,
  lessonId: string,
  courseId: string,
  videoId: string,
  sessionToken: string,
  now: Date = new Date()
): Promise<SessionWithGapCheckResult> {
  if (LESSON_ENTRY_GAP_MS <= 0) {
    const { session, created } = await getOrCreateSession(ds, userId, lessonId, courseId, videoId, sessionToken);
    return { kind: "allowed", session, created };
  }

  const deadlineAt = new Date(now.getTime() + SESSION_DURATION_MS).toISOString();
  try {
    return await ds.createSessionWithGapCheck({
      userId,
      lessonId,
      courseId,
      videoId,
      sessionToken,
      now: now.toISOString(),
      deadlineAt,
      gapMs: LESSON_ENTRY_GAP_MS,
    });
  } catch (err) {
    logger.error("getOrCreateSessionWithGapCheck: transaction failed, failing open (entry allowed)", {
      errorType: "lesson_entry_gap_check_failed",
      userId,
      lessonId,
      courseId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    const { session, created } = await getOrCreateSession(ds, userId, lessonId, courseId, videoId, sessionToken);
    return { kind: "allowed", session, created };
  }
}

export interface EntryCooldownPreview {
  blocked: boolean;
  retryAfterMs?: number;
  nextEntryAllowedAt?: string;
  previousLessonId?: string;
}

/**
 * F1: 入室最小間隔の事前プレビュー（read-only、session を作成しない）。
 *
 * `GET /lesson-sessions/active` から、受講者がまだ入室していない状態でも
 * 「あと何秒待てば次のレッスンに入れるか」を事前表示するために使う
 * （FE の事前ゲート表示。実際のブロックは `getOrCreateSessionWithGapCheck` が担う）。
 *
 * `createSessionWithGapCheck` と判定順は同一だが、書き込みを行わないため
 * トランザクション不要（DataSource の通常read APIのみで完結）。
 */
export async function previewEntryCooldown(
  ds: DataSource,
  userId: string,
  lessonId: string,
  courseId: string,
  now: Date = new Date()
): Promise<EntryCooldownPreview> {
  if (LESSON_ENTRY_GAP_MS <= 0) return { blocked: false };

  const activeOnLesson = await ds.getActiveLessonSession(userId, lessonId);
  if (activeOnLesson) return { blocked: false };

  const sessions = await ds.getLessonSessionsByUserAndCourse(userId, courseId);
  return evaluateEntryGap(sessions, lessonId, now.getTime(), LESSON_ENTRY_GAP_MS);
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
    // Issue #425: transient Firestore エラー (UNAVAILABLE / DEADLINE_EXCEEDED 等) に対する
    // 共通リトライ。permanent エラーは即 throw、transient は exponential backoff で最大 3 回試行。
    quiz = await withTransientRetry(() => ds.getQuizByLessonId(lessonId), {
      context: { operation: "cleanupInProgressAttempts.getQuizByLessonId", userId, lessonId },
    });
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
    // Issue #425: transient retry (上記 getQuizByLessonId と同じ方針)
    attempts = await withTransientRetry(
      () => ds.getQuizAttempts({ quizId: quiz!.id, userId }),
      {
        context: {
          operation: "cleanupInProgressAttempts.getQuizAttempts",
          userId,
          lessonId,
          quizId: quiz.id,
        },
      },
    );
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
      // Issue #425: 個別 attempt の transition も transient retry。
      // 部分救済優先 (1 件失敗でも全停止せず continue)。
      const result = await withTransientRetry(
        () => ds.transitionQuizAttemptToTimedOut(attempt.id),
        {
          context: {
            operation: "cleanupInProgressAttempts.transitionQuizAttemptToTimedOut",
            userId,
            lessonId,
            attemptId: attempt.id,
          },
        },
      );
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
 *
 * ADR-027 改訂履歴 2026-05-21（ケース E 救済拡張）:
 *   過去に動画を完了済みのユーザー（永続 video_analytics.isComplete=true）が
 *   再受験時に動画を再生して time_limit / pause_timeout に陥った場合も
 *   既存完了データを保護する。max_attempts_failed は受験規律破りとして
 *   全リセット維持（ADR-027 ケース F semantics）。
 *
 *   永続完了の判定は「現在 lesson の video」と一致するセッションのみ尊重。
 *   動画差し替え後のセッションは既存挙動（全リセット）にフォールバックする。
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
  //
  // さらに、過去に動画完了済みのユーザーが再受験時に動画再生 → time_limit /
  // pause_timeout に陥った場合も、永続 video_analytics.isComplete=true を尊重し
  // データを保護する（ケース E 救済拡張、ADR-027 改訂履歴 2026-05-21）。
  // max_attempts_failed は受験規律破りなので永続フラグに関わらず全リセット。
  const hasCompletedCurrentVideo = await hasPersistentVideoCompletion(ds, session, reason);
  const shouldSkipReset = session.sessionVideoCompleted || hasCompletedCurrentVideo;

  if (shouldSkipReset) {
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
 * 現在 lesson の video に対する永続完了状態を確認する（ケース E' 救済判定）。
 *
 * 救済対象 reason は time_limit / pause_timeout のみ。
 * max_attempts_failed は受験規律破りのため永続フラグを尊重しない（ADR-027 ケース F）。
 *
 * 動画差し替え検知: getVideoByLessonId で取得した現在 video の id が
 * session.videoId と一致する場合のみ永続完了を尊重する。
 * セッション開始後にレッスンの動画が差し替えられた場合は false を返し、
 * 既存挙動（全リセット）にフォールバックする（observability 確保のため warn ログ出力）。
 *
 * 例外時のフォールバック方針（safe-by-default）:
 *   getVideoAnalytics / getVideoByLessonId の例外時は true を返す（skip reset 側）。
 *   理由: 本 PR の目的は完了済みデータの保護。fetch 失敗時に false → 全リセットに
 *   倒すと、永続 isComplete=true の真値を持つユーザーのデータも transient エラーで
 *   破壊される（PR 趣旨と矛盾）。Firestore 不健全時はデータ保護を優先する。
 *   副作用として初回視聴中ユーザーの false positive 救済が起こり得るが、
 *   cleanupInProgressAttempts は走るため in_progress attempt は終端化され、
 *   次回新セッションで動画完了させれば規律装置の元の挙動に戻る。
 *   logger.error は errorType=persistent_completion_check_failed で記録するため、
 *   発火頻度の監視は Cloud Logging のフィルタで実施する（alerting 設定は follow-up）。
 */
async function hasPersistentVideoCompletion(
  ds: DataSource,
  session: LessonSession,
  reason: SessionExitReason
): Promise<boolean> {
  if (reason !== "time_limit" && reason !== "pause_timeout") {
    return false;
  }
  try {
    const currentVideo = await ds.getVideoByLessonId(session.lessonId);
    if (!currentVideo) {
      // 動画が削除済（lesson から video が外された）。旧 video の永続完了は尊重しない。
      logger.warn("hasPersistentVideoCompletion: lesson video missing, routing to reset", {
        eventType: "persistent_completion_skip_video_missing",
        sessionId: session.id,
        userId: session.userId,
        lessonId: session.lessonId,
        sessionVideoId: session.videoId,
      });
      return false;
    }
    if (currentVideo.id !== session.videoId) {
      // セッション開始後に動画差し替え。observability のため info ログを残す。
      logger.info("hasPersistentVideoCompletion: video swapped after session start, routing to reset", {
        eventType: "persistent_completion_skip_video_swapped",
        sessionId: session.id,
        userId: session.userId,
        lessonId: session.lessonId,
        sessionVideoId: session.videoId,
        currentVideoId: currentVideo.id,
      });
      return false;
    }
    const analytics = await ds.getVideoAnalytics(session.userId, session.videoId);
    return analytics?.isComplete === true;
  } catch (err) {
    logger.error("hasPersistentVideoCompletion: failed to query video/analytics", {
      errorType: "persistent_completion_check_failed",
      sessionId: session.id,
      userId: session.userId,
      lessonId: session.lessonId,
      videoId: session.videoId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    // safe-by-default: skip reset 側にフォールバック（データ保護優先、本 PR 趣旨と整合）
    return true;
  }
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
 * セッションを指定の exitReason で完了（退室打刻）
 *
 * Issue #424 (Codex Medium 88): TOCTOU 縮小のため updateLessonSession 直前に status を再確認する。
 * 並行 abandonSession / forceExitSession で active でなくなっていた場合は skip (null を返す)。
 *
 * 完全な atomicity (transaction レベル) は DataSource インターフェースに条件付き更新
 * (transitionLessonSessionToCompleted 等) を追加する必要があり、scope 拡大のため follow-up 候補。
 * 本実装は再確認 → 更新の間の race window を最小化する best-effort 改善。
 *
 * テスト任意化 Stage 3: `completeSession`（合格提出用、exitReason 固定）と
 * `completeSessionAsQuizSkipped`（スキップ用）の共通実装として export せず内部利用する。
 */
async function completeSessionWithReason(
  ds: DataSource,
  sessionId: string,
  reason: SessionExitReason,
  quizAttemptId: string | null
): Promise<LessonSession | null> {
  const current = await ds.getLessonSession(sessionId);
  if (!current) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (current.status !== "active") {
    // 並行 abandon / forceExit / 別経路の完了で active でなくなった → 完了処理 skip
    logger.warn("completeSessionWithReason: session is no longer active, skipping", {
      eventType: "complete_session_skipped_non_active",
      sessionId,
      currentStatus: current.status,
      reason,
      quizAttemptId,
    });
    return null;
  }

  const updated = await ds.updateLessonSession(sessionId, {
    status: "completed",
    exitAt: new Date().toISOString(),
    exitReason: reason,
    quizAttemptId,
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
): Promise<LessonSession | null> {
  return completeSessionWithReason(ds, sessionId, "quiz_submitted", quizAttemptId);
}

/**
 * テスト任意化 Stage 3: セッションをテストスキップで完了（退室打刻）。
 *
 * `completeSession` と異なり quizAttemptId を持たない（スキップは attempt を作らないため）。
 * 呼び出し直前に `ds.getLessonSession` で状態を再確認する点は `completeSession` と同様、
 * 合格提出との並行競合（同一セッションへの二重完了）も同じ quiet-pass ルールで防ぐ。
 */
export async function completeSessionAsQuizSkipped(
  ds: DataSource,
  sessionId: string
): Promise<LessonSession | null> {
  return completeSessionWithReason(ds, sessionId, "quiz_skipped", null);
}

/**
 * テスト任意化 Stage 3 で新設した `createSyntheticSkippedSession`（スキップ用）とは別物。
 * 本関数は「合格提出」時の補完 session 作成専用で、`PATCH /quiz-attempts/:attemptId` の
 * 合格パスから呼び出される。
 *
 * ケース D 厳格化（Stage 5）: `QUIZ_REQUIRE_ACTIVE_SESSION=true`（デフォルト）では
 * activeSession=null での提出自体が新設ゲートで塞がれるため、本関数は到達不能な
 * dead path になる。`=false` へロールバックした場合のみ引き続き呼び出される
 * （Issue #533 の乖離再発防止のため意図的に温存、Stage 6 で削除・`@deprecated` 化を検討）。
 *
 * Issue #533: active session なしで quiz が合格提出された場合の補完 session を作成。
 *
 * 背景: quiz-attempts.ts は `QUIZ_REQUIRE_ACTIVE_SESSION=false` 時のみ後方互換のため
 * activeSession=null でも提出を許可する（quiz-attempts.ts の PATCH ハンドラのコメント参照）。
 * これにより lesson_sessions に痕跡が残らず、
 * user_progress (quizPassed/quizBestScore) と乖離する事象が発生していた (長遊園様で 4 件)。
 *
 * 本関数は決定的 doc id `synthetic_{quizAttemptId}` で session を作成、冪等性を保証する。
 * 既存があればそれを返す (リトライ・backfill 再実行で重複作成しない)。
 *
 * **D 案 (Phase 3 follow-up #4)**: 業務的「動画見てテスト受験して合格」のフル時間を反映するため、
 * entryAt = quiz.startedAt (実刻維持) / exitAt = startedAt + videoDurationMs + quizDurationMs (換算退室時刻)。
 * ADR-019 動画完了ゲートにより自動補完対象は必ず過去に動画視聴完了済 (業務的根拠)。
 *
 * 失敗時は呼び出し元で catch する想定。本関数自体は例外を投げる。
 * 呼び出し元 (quiz-attempts.ts) は提出成功を優先するため、catch して logger.error に逃す。
 */
export async function createSyntheticCompletedSession(
  ds: DataSource,
  params: {
    userId: string;
    lessonId: string;
    courseId: string;
    videoId: string;
    quizAttemptId: string;
    startedAt: string;
    submittedAt: string;
    videoDurationSec: number;
  }
): Promise<{ session: LessonSession; created: boolean }> {
  // video.durationSec hard guard (Codex 指摘 #2 反映)。
  // Number.isFinite で NaN/Infinity をブロック、> 0 で 0/負数をブロック。
  if (!Number.isFinite(params.videoDurationSec) || params.videoDurationSec <= 0) {
    throw new Error(
      `createSyntheticCompletedSession: invalid videoDurationSec=${params.videoDurationSec} for lesson ${params.lessonId}`
    );
  }

  const id = `synthetic_${params.quizAttemptId}`;
  const startedMs = new Date(params.startedAt).getTime();
  const submittedMs = new Date(params.submittedAt).getTime();
  const quizDurationMs = submittedMs - startedMs;
  const videoDurationMs = params.videoDurationSec * 1000;
  // D 案: 業務的「動画見てテスト受験して合格」の換算退室時刻 (実打刻ではない)。
  const exitAt = new Date(startedMs + videoDurationMs + quizDurationMs).toISOString();
  // 合成 session の deadlineAt は意味的に不要 (completed 状態で validate されない) が、
  // 型は必須なので entryAt + SESSION_DURATION_MS で safe default。
  const deadlineAt = new Date(startedMs + SESSION_DURATION_MS).toISOString();

  return ds.createLessonSessionWithId(id, {
    userId: params.userId,
    lessonId: params.lessonId,
    courseId: params.courseId,
    videoId: params.videoId,
    sessionToken: `synthetic-${params.quizAttemptId}`,
    status: "completed",
    entryAt: params.startedAt,
    exitAt,
    exitReason: "quiz_submitted",
    deadlineAt,
    pauseStartedAt: null,
    longestPauseSec: 0,
    sessionVideoCompleted: true, // 合格時点で video 完了済みと見なす (進捗ページの latest 表示で違和感ないように)
    quizAttemptId: params.quizAttemptId,
    isSynthetic: true,
  });
}

/**
 * テスト任意化 Stage 3: active session なしでテストがスキップされた場合の補完 session を作成。
 *
 * `createSyntheticCompletedSession`（合格用、doc id は attempt 単位）とは異なり、
 * doc id を `synthetic_skip_{userId}_{lessonId}` という (受講者, レッスン) 単位の決定的 ID にする。
 * これにより同一受講者が同一レッスンで何度スキップ API を叩いても 1 行に固定され、
 * 出席レポートの重複行（本ミッションが根治対象とする既存不具合と同種）を構造的に防ぐ。
 *
 * ADR-027 D 案と対称に、entryAt を換算値にする（exitAt = スキップ実時刻を実刻として維持し、
 * entryAt = exitAt - videoDurationSec*1000 を「動画を見てからスキップした」換算入室時刻とする）。
 *
 * `createLessonSessionWithId` の冪等性（既存 doc があれば created:false で返す）により、
 * 呼び出し元は毎回無条件に呼んでよい。
 */
export async function createSyntheticSkippedSession(
  ds: DataSource,
  params: {
    userId: string;
    lessonId: string;
    courseId: string;
    videoId: string;
    videoDurationSec: number;
    skippedAt: string;
  }
): Promise<{ session: LessonSession; created: boolean }> {
  // video.durationSec hard guard（createSyntheticCompletedSession と同方針）
  if (!Number.isFinite(params.videoDurationSec) || params.videoDurationSec <= 0) {
    throw new Error(
      `createSyntheticSkippedSession: invalid videoDurationSec=${params.videoDurationSec} for lesson ${params.lessonId}`
    );
  }
  // userId/lessonId は Firestore ドキュメント ID を組み立てる決定的キーの一部になるため、
  // パス区切り文字を含まないことを防御的に確認する（Codex plan review 指摘反映）。
  if (params.userId.includes("/") || params.lessonId.includes("/")) {
    throw new Error(
      `createSyntheticSkippedSession: userId/lessonId must not contain "/" (userId=${params.userId}, lessonId=${params.lessonId})`
    );
  }

  const id = `synthetic_skip_${params.userId}_${params.lessonId}`;
  const skippedMs = new Date(params.skippedAt).getTime();
  const videoDurationMs = params.videoDurationSec * 1000;
  // 換算入室時刻（実打刻ではない、ADR-027 D 案と対称の設計）
  const entryAt = new Date(skippedMs - videoDurationMs).toISOString();
  const deadlineAt = new Date(skippedMs + SESSION_DURATION_MS).toISOString();

  return ds.createLessonSessionWithId(id, {
    userId: params.userId,
    lessonId: params.lessonId,
    courseId: params.courseId,
    videoId: params.videoId,
    sessionToken: `synthetic-skip-${params.userId}-${params.lessonId}`,
    status: "completed",
    entryAt,
    exitAt: params.skippedAt,
    exitReason: "quiz_skipped",
    deadlineAt,
    pauseStartedAt: null,
    longestPauseSec: 0,
    sessionVideoCompleted: true,
    quizAttemptId: null,
    isSynthetic: true,
  });
}

/**
 * テスト任意化 Stage 5: クイズ受験のためのセッション状態を判別する共通ヘルパー。
 *
 * `getActiveLessonSession`（status のみ、期限を見ない）と `validateSessionDeadline`
 * （期限のみ、status を見ない）が分離しているため、POST/PATCH 双方で同じ判定を
 * 二重に書かずに済むよう集約する。
 */
export type ActiveSessionForQuiz =
  | { kind: "active"; session: LessonSession }
  | { kind: "expired"; session: LessonSession }
  | { kind: "none" };

export async function resolveActiveSessionForQuiz(
  ds: DataSource,
  userId: string,
  lessonId: string
): Promise<ActiveSessionForQuiz> {
  const session = await ds.getActiveLessonSession(userId, lessonId);
  if (!session) return { kind: "none" };
  if (!validateSessionDeadline(session)) return { kind: "expired", session };
  return { kind: "active", session };
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
