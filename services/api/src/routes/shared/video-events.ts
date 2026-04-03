/**
 * 動画イベント収集ルーター
 * ADR-014: クライアントは生イベント送信、サーバーが集計
 * ADR-021: 最大50件/リクエスト
 * ADR-022: サーバーサイドヒューリスティクスで不審パターン検出
 */

import { Router, Request, Response } from "express";
import { requireUser } from "../../middleware/auth.js";
import type { VideoEventType } from "../../types/entities.js";
import { processVideoEvents } from "../../services/video-analytics.js";
import { updateLessonProgress } from "../../services/progress.js";
import { forceExitSession } from "../../services/lesson-session.js";
import { checkVideoAccess } from "../../services/enrollment.js";
import { logger } from "../../utils/logger.js";

const PAUSE_TIMEOUT_MS = Number(process.env.PAUSE_TIMEOUT_MS) || 15 * 60 * 1000; // デフォルト15分

const router = Router();

const VALID_EVENT_TYPES: VideoEventType[] = [
  "play",
  "pause",
  "seeking",
  "seeked",
  "ended",
  "heartbeat",
  "ratechange",
  "visibility_hidden",
  "visibility_visible",
];

const MAX_EVENTS_PER_REQUEST = 50;

/**
 * 動画イベントバッチ受信
 * POST /videos/:videoId/events
 * body: {
 *   sessionToken: string,
 *   events: Array<{
 *     eventType: VideoEventType,
 *     position: number,
 *     seekFrom?: number,
 *     playbackRate: number,
 *     clientTimestamp: number,
 *     metadata?: Record<string, unknown>
 *   }>
 * }
 */
router.post("/videos/:videoId/events", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const videoId = req.params.videoId as string;
  const userId = req.user!.id;
  const { sessionToken, events } = req.body;

  // 1. バリデーション

  // sessionToken
  if (!sessionToken || typeof sessionToken !== "string" || sessionToken.trim() === "") {
    res.status(400).json({ error: "invalid_session_token", message: "sessionToken is required" });
    return;
  }

  // events配列
  if (!Array.isArray(events)) {
    res.status(400).json({ error: "invalid_events", message: "events must be an array" });
    return;
  }

  if (events.length === 0) {
    res.status(400).json({ error: "invalid_events", message: "events array must not be empty" });
    return;
  }

  // ADR-021: 最大50件/リクエスト
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    res.status(400).json({
      error: "too_many_events",
      message: `Maximum ${MAX_EVENTS_PER_REQUEST} events per request`,
    });
    return;
  }

  // 各イベントのフィールド確認
  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (!event || typeof event !== "object") {
      res.status(400).json({ error: "invalid_event", message: `events[${i}] must be an object` });
      return;
    }

    if (!event.eventType || !VALID_EVENT_TYPES.includes(event.eventType)) {
      res.status(400).json({
        error: "invalid_event_type",
        message: `events[${i}].eventType must be one of: ${VALID_EVENT_TYPES.join(", ")}`,
      });
      return;
    }

    if (typeof event.position !== "number" || event.position < 0) {
      res.status(400).json({
        error: "invalid_position",
        message: `events[${i}].position must be a non-negative number`,
      });
      return;
    }

    if (typeof event.playbackRate !== "number" || event.playbackRate <= 0) {
      res.status(400).json({
        error: "invalid_playback_rate",
        message: `events[${i}].playbackRate must be a positive number`,
      });
      return;
    }

    if (typeof event.clientTimestamp !== "number" || event.clientTimestamp <= 0) {
      res.status(400).json({
        error: "invalid_client_timestamp",
        message: `events[${i}].clientTimestamp must be a positive number`,
      });
      return;
    }

    if (event.seekFrom !== undefined && typeof event.seekFrom !== "number") {
      res.status(400).json({
        error: "invalid_seek_from",
        message: `events[${i}].seekFrom must be a number when provided`,
      });
      return;
    }
  }

  // イベント受信ログ
  const eventTypes = events.reduce((acc: Record<string, number>, e: { eventType: string }) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {});
  logger.info("Video events received", { userId, videoId, eventCount: events.length, eventTypes });

  // 2. 動画取得（durationSec, requiredWatchRatio取得）
  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found" });
    return;
  }

  // 2.5. 受講期間チェック
  try {
    const enrollmentSetting = await ds.getCourseEnrollmentSetting(video.courseId);
    const videoAccessResult = checkVideoAccess(enrollmentSetting);
    if (!videoAccessResult.allowed) {
      res.status(403).json({
        error: videoAccessResult.reason,
        message: "動画視聴期間が終了しています",
      });
      return;
    }
  } catch (err) {
    console.error(`Failed to check video access for courseId ${video.courseId}:`, err);
    res.status(500).json({
      error: "enrollment_check_failed",
      message: "受講期限チェックが失敗しました",
    });
    return;
  }

  // 3. dataSource.createVideoEvents() でイベント保存
  const eventsToCreate = events.map((event) => ({
    videoId,
    userId,
    sessionToken: sessionToken.trim(),
    eventType: event.eventType as VideoEventType,
    position: event.position,
    seekFrom: event.seekFrom ?? undefined,
    playbackRate: event.playbackRate,
    clientTimestamp: event.clientTimestamp,
    metadata: event.metadata ?? undefined,
  }));

  // 3.5. セッション取得 + sessionToken照合 + 15分超過チェック（ADR-027）
  // イベント保存前にチェック: forceExitSessionがデータリセットするため、保存→即削除を回避
  const activeSession = await ds.getActiveLessonSession(userId, video.lessonId);
  if (activeSession && activeSession.sessionToken !== sessionToken.trim()) {
    res.status(400).json({
      error: "session_token_mismatch",
      message: "sessionToken does not match active session",
    });
    return;
  }
  if (activeSession?.pauseStartedAt && !activeSession.sessionVideoCompleted) {
    // 動画完了済みセッション（sessionVideoCompleted=true）ではpauseタイムアウトを適用しない。
    // 動画のendedイベントはHTML5のpause状態を伴うため、完了後の自然なpauseで
    // 強制退室→データ全消去が発動するのを防止する。
    const pausedMs = Date.now() - new Date(activeSession.pauseStartedAt).getTime();
    if (pausedMs > PAUSE_TIMEOUT_MS) {
      try {
        await forceExitSession(ds, activeSession.id, "pause_timeout");
      } catch (err) {
        logger.error("Failed to force-exit session on pause timeout", {
          error: String(err), sessionId: activeSession.id, userId,
        });
      }
      res.status(409).json({ error: "session_force_exited", message: "一時停止が15分を超過しました" });
      return;
    }
  }

  const savedEvents = await ds.createVideoEvents(eventsToCreate);

  // 3.6. バッチ内のpause/playイベントで状態を更新
  // 失敗してもanalytics応答は返す（pause追跡は二次的機能）
  if (activeSession) {
    try {
      // 配列インデックスで順序判定（clientTimestampに依存しない）
      let pauseIndex = -1;
      let playIndex = -1;
      for (let i = savedEvents.length - 1; i >= 0; i--) {
        if (pauseIndex < 0 && savedEvents[i].eventType === "pause") pauseIndex = i;
        if (playIndex < 0 && savedEvents[i].eventType === "play") playIndex = i;
        if (pauseIndex >= 0 && playIndex >= 0) break;
      }

      if (pauseIndex >= 0 && pauseIndex > playIndex) {
        await ds.updateLessonSession(activeSession.id, {
          pauseStartedAt: new Date().toISOString(),
        });
      } else if (playIndex >= 0 && activeSession.pauseStartedAt) {
        const pauseDurationSec = Math.floor(
          (Date.now() - new Date(activeSession.pauseStartedAt).getTime()) / 1000
        );
        if (!Number.isFinite(pauseDurationSec) || pauseDurationSec < 0) {
          logger.warn("Invalid pause duration computed, skipping update", {
            pauseStartedAt: activeSession.pauseStartedAt,
            pauseDurationSec,
            sessionId: activeSession.id, userId, videoId,
          });
        } else {
          const longestPauseSec = Math.max(activeSession.longestPauseSec, pauseDurationSec);
          await ds.updateLessonSession(activeSession.id, {
            pauseStartedAt: null,
            longestPauseSec,
          });
        }
      }
    } catch (err) {
      logger.error("Failed to update session pause state", {
        error: err instanceof Error ? err : String(err),
        sessionId: activeSession.id, userId, videoId,
      });
    }
  }

  // 4-7. アトミックにanalytics読み取り→集計→書き込み（ロストアップデート防止）
  let updatedAnalytics;
  try {
    updatedAnalytics = await ds.computeAndUpsertVideoAnalytics(userId, videoId, (currentAnalytics) => {
      const analyticsUpdate = processVideoEvents(savedEvents, currentAnalytics, video.durationSec);
      const coverageRatio = analyticsUpdate.coverageRatio ?? 0;
      const isComplete = coverageRatio >= video.requiredWatchRatio;
      return { ...analyticsUpdate, isComplete };
    });
    logger.info("Video analytics updated", {
      userId, videoId,
      coverageRatio: updatedAnalytics.coverageRatio,
      isComplete: updatedAnalytics.isComplete,
      watchedRangesCount: updatedAnalytics.watchedRanges?.length ?? 0,
      totalWatchTimeSec: updatedAnalytics.totalWatchTimeSec,
      requiredWatchRatio: video.requiredWatchRatio,
    });
  } catch (err) {
    logger.error("Failed to update video analytics", {
      error: err instanceof Error ? err : String(err),
      userId, videoId, eventCount: savedEvents.length,
    });
    res.status(500).json({
      error: "analytics_update_failed",
      message: "イベントは保存されましたが、分析データの更新に失敗しました",
    });
    return;
  }

  const isComplete = updatedAnalytics.isComplete;

  // 8. 進捗更新: isComplete=true になった場合
  if (isComplete) {
    logger.info("Video completed - updating progress", {
      userId, videoId, lessonId: video.lessonId,
      coverageRatio: updatedAnalytics.coverageRatio,
      requiredWatchRatio: video.requiredWatchRatio,
    });

    const lesson = await ds.getLessonById(video.lessonId);
    if (lesson) {
      // テストなしレッスンの場合、quizPassed=trueとして完了扱い
      const quizPassed = !lesson.hasQuiz;
      await updateLessonProgress(ds, userId, lesson.id, lesson.courseId, {
        videoCompleted: true,
        quizPassed: quizPassed ? true : undefined,
      });
      logger.info("Lesson progress updated", {
        userId, lessonId: lesson.id, courseId: lesson.courseId,
        videoCompleted: true, quizPassed,
      });
    }

    // セッション内動画視聴完了フラグを更新（step 3.5で取得済みのセッションを再利用）
    if (activeSession && !activeSession.sessionVideoCompleted) {
      await ds.updateLessonSession(activeSession.id, { sessionVideoCompleted: true });
      logger.info("Session video completed", { sessionId: activeSession.id, userId, videoId });
    }
  }

  // 9. レスポンス
  res.json({
    analytics: {
      coverageRatio: updatedAnalytics.coverageRatio,
      isComplete: updatedAnalytics.isComplete,
      watchedRanges: updatedAnalytics.watchedRanges,
    },
  });
});

export const videoEventsRouter = router;
