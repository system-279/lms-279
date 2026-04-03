/**
 * 動画管理の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireUser, requireAdmin } from "../../middleware/auth.js";
import {
  generateUploadUrl,
  moveToVideoBucket,
  generatePlaybackUrl,
  deleteVideoFile,
} from "../../services/gcs.js";
import { guardVideoAccess } from "../../services/enrollment.js";
import { logger } from "../../utils/logger.js";

const router = Router();

// ============================================================
// 管理者向けエンドポイント
// ============================================================

/**
 * 管理者向け: GCS署名付きアップロードURL発行
 * POST /admin/videos/upload-url
 * ボディ:
 *   - fileName: string (必須)
 *   - contentType: string (必須)
 */
router.post("/admin/videos/upload-url", requireAdmin, async (req: Request, res: Response) => {
  const { fileName, contentType } = req.body;
  const tenantId = req.tenantContext!.tenantId;

  if (!fileName || typeof fileName !== "string" || fileName.trim() === "") {
    res.status(400).json({ error: "invalid_fileName", message: "fileName is required" });
    return;
  }

  if (!contentType || typeof contentType !== "string" || contentType.trim() === "") {
    res.status(400).json({ error: "invalid_contentType", message: "contentType is required" });
    return;
  }

  const { uploadUrl, gcsPath } = await generateUploadUrl(fileName.trim(), contentType.trim(), tenantId);

  res.status(200).json({ uploadUrl, gcsPath });
});

/**
 * 管理者向け: 動画メタデータ登録
 * POST /admin/lessons/:lessonId/video
 * ボディ:
 *   - gcsPath: string (必須)
 *   - sourceType?: "gcs" | "external_url"
 *   - sourceUrl?: string
 *   - durationSec: number (必須)
 *   - requiredWatchRatio?: number
 *   - speedLock?: boolean
 */
router.post("/admin/lessons/:lessonId/video", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;
  const { gcsPath, sourceType, sourceUrl, durationSec, requiredWatchRatio, speedLock } = req.body;

  // レッスン存在チェック
  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "Lesson not found" });
    return;
  }

  // 既存動画チェック
  const existing = await ds.getVideoByLessonId(lessonId);
  if (existing) {
    res.status(409).json({ error: "video_already_exists", message: "A video already exists for this lesson" });
    return;
  }

  if (durationSec === undefined || durationSec === null || typeof durationSec !== "number") {
    res.status(400).json({ error: "invalid_durationSec", message: "durationSec is required and must be a number" });
    return;
  }

  const resolvedSourceType = sourceType ?? "gcs";

  // gcs ソースの場合: アップロードバケットから動画バケットへ移動
  let resolvedGcsPath: string | undefined;
  if (resolvedSourceType === "gcs") {
    if (!gcsPath || typeof gcsPath !== "string") {
      res.status(400).json({ error: "invalid_gcsPath", message: "gcsPath is required for sourceType=gcs" });
      return;
    }
    resolvedGcsPath = await moveToVideoBucket(gcsPath);
  }

  const video = await ds.createVideo({
    lessonId,
    courseId: lesson.courseId,
    sourceType: resolvedSourceType,
    ...(resolvedGcsPath !== undefined && { gcsPath: resolvedGcsPath }),
    ...(sourceUrl !== undefined && { sourceUrl }),
    durationSec,
    requiredWatchRatio: requiredWatchRatio ?? 0.95,
    speedLock: speedLock ?? true,
  });

  // lesson.hasVideo = true に更新
  await ds.updateLesson(lessonId, { hasVideo: true });

  res.status(201).json({
    video: {
      id: video.id,
      lessonId: video.lessonId,
      courseId: video.courseId,
      sourceType: video.sourceType,
      gcsPath: video.gcsPath,
      sourceUrl: video.sourceUrl,
      durationSec: video.durationSec,
      requiredWatchRatio: video.requiredWatchRatio,
      speedLock: video.speedLock,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    },
  });
});

/**
 * 管理者向け: 動画メタデータ更新
 * PATCH /admin/lessons/:lessonId/video
 * ボディ:
 *   - durationSec?: number
 *   - requiredWatchRatio?: number
 *   - speedLock?: boolean
 */
router.patch("/admin/lessons/:lessonId/video", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;
  const { durationSec, requiredWatchRatio, speedLock } = req.body;

  const video = await ds.getVideoByLessonId(lessonId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found for this lesson" });
    return;
  }

  const updated = await ds.updateVideo(video.id, {
    ...(durationSec !== undefined && { durationSec }),
    ...(requiredWatchRatio !== undefined && { requiredWatchRatio }),
    ...(speedLock !== undefined && { speedLock }),
  });

  res.json({
    video: {
      id: updated!.id,
      lessonId: updated!.lessonId,
      courseId: updated!.courseId,
      sourceType: updated!.sourceType,
      gcsPath: updated!.gcsPath,
      sourceUrl: updated!.sourceUrl,
      durationSec: updated!.durationSec,
      requiredWatchRatio: updated!.requiredWatchRatio,
      speedLock: updated!.speedLock,
      createdAt: updated!.createdAt,
      updatedAt: updated!.updatedAt,
    },
  });
});

/**
 * 管理者向け: 動画削除
 * DELETE /admin/lessons/:lessonId/video
 */
router.delete("/admin/lessons/:lessonId/video", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;

  const video = await ds.getVideoByLessonId(lessonId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found for this lesson" });
    return;
  }

  // GCSファイル削除（gcsPath がある場合）
  if (video.gcsPath) {
    await deleteVideoFile(video.gcsPath);
  }

  await ds.deleteVideo(video.id);

  // lesson.hasVideo = false に更新
  await ds.updateLesson(lessonId, { hasVideo: false });

  res.status(204).send();
});

// ============================================================
// 受講者向けエンドポイント
// ============================================================

/**
 * 受講者向け: レッスンに紐づく動画のIDとメタデータ取得
 * GET /lessons/:lessonId/video
 */
router.get("/lessons/:lessonId/video", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;

  const video = await ds.getVideoByLessonId(lessonId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found for this lesson" });
    return;
  }

  res.json({
    video: {
      id: video.id,
      lessonId: video.lessonId,
      durationSec: video.durationSec,
      requiredWatchRatio: video.requiredWatchRatio,
      speedLock: video.speedLock,
    },
  });
});

/**
 * 受講者向け: 署名付き再生URL取得
 * GET /videos/:videoId/playback-url
 */
router.get("/videos/:videoId/playback-url", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const videoId = req.params.videoId as string;

  const userId = req.user!.id;
  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found" });
    return;
  }

  // 受講期間チェック
  const videoBlocked = await guardVideoAccess(req, res, video.courseId);
  if (videoBlocked) return;

  let playbackUrl: string;

  if ((video.sourceType === "gcs" || video.sourceType === "google_drive") && video.gcsPath) {
    playbackUrl = await generatePlaybackUrl(video.gcsPath);
  } else if (video.sourceType === "external_url" && video.sourceUrl) {
    playbackUrl = video.sourceUrl;
  } else {
    res.status(500).json({ error: "invalid_video_source", message: "Video source is not properly configured" });
    return;
  }

  logger.info("Playback URL issued", {
    userId, videoId, sourceType: video.sourceType, lessonId: video.lessonId,
  });

  res.json({
    playbackUrl,
    video: {
      id: video.id,
      durationSec: video.durationSec,
      requiredWatchRatio: video.requiredWatchRatio,
      speedLock: video.speedLock,
    },
  });
});

/**
 * 受講者向け: 自分の視聴状況取得
 * GET /videos/:videoId/analytics
 */
router.get("/videos/:videoId/analytics", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const videoId = req.params.videoId as string;

  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found" });
    return;
  }

  const analytics = await ds.getVideoAnalytics(userId, videoId);

  if (!analytics) {
    // デフォルト値を返す
    res.json({
      analytics: {
        videoId,
        userId,
        watchedRanges: [],
        totalWatchTimeSec: 0,
        coverageRatio: 0,
        isComplete: false,
        seekCount: 0,
        pauseCount: 0,
        totalPauseDurationSec: 0,
        speedViolationCount: 0,
        suspiciousFlags: [],
      },
    });
    return;
  }

  res.json({
    analytics: {
      videoId: analytics.videoId,
      userId: analytics.userId,
      watchedRanges: analytics.watchedRanges,
      totalWatchTimeSec: analytics.totalWatchTimeSec,
      coverageRatio: analytics.coverageRatio,
      isComplete: analytics.isComplete,
      seekCount: analytics.seekCount,
      pauseCount: analytics.pauseCount,
      totalPauseDurationSec: analytics.totalPauseDurationSec,
      speedViolationCount: analytics.speedViolationCount,
      suspiciousFlags: analytics.suspiciousFlags,
      updatedAt: analytics.updatedAt,
    },
  });
});

export const videosRouter = router;
