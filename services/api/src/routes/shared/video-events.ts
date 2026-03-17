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

const router = Router();

const VALID_EVENT_TYPES: VideoEventType[] = [
  "play",
  "pause",
  "seek",
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

  // 2. 動画取得（durationSec, requiredWatchRatio取得）
  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found" });
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

  const savedEvents = await ds.createVideoEvents(eventsToCreate);

  // 4. 現在のanalytics取得
  const currentAnalytics = await ds.getVideoAnalytics(userId, videoId);

  // 5. processVideoEvents() で集計
  const analyticsUpdate = processVideoEvents(savedEvents, currentAnalytics, video.durationSec);

  // 6. isComplete判定: coverageRatio >= video.requiredWatchRatio
  const coverageRatio = analyticsUpdate.coverageRatio ?? 0;
  const isComplete = coverageRatio >= video.requiredWatchRatio;

  // 7. dataSource.upsertVideoAnalytics() で更新
  const updatedAnalytics = await ds.upsertVideoAnalytics(userId, videoId, {
    ...analyticsUpdate,
    isComplete,
  });

  // 8. レスポンス
  res.json({
    analytics: {
      coverageRatio: updatedAnalytics.coverageRatio,
      isComplete: updatedAnalytics.isComplete,
      watchedRanges: updatedAnalytics.watchedRanges,
    },
  });
});

export const videoEventsRouter = router;
