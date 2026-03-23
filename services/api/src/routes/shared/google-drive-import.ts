/**
 * Google Drive動画インポートルーター
 * Drive URLから動画をGCSにコピーし、既存の署名付きURL再生フローで配信
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { isWorkspaceIntegrationAvailable } from "../../services/google-auth.js";
import {
  parseDriveUrl,
  getDriveFileMetadata,
  validateDriveFileMetadata,
  copyDriveFileToGCS,
} from "../../services/google-drive.js";

const router = Router();

/**
 * Google Driveから動画をインポート
 * POST /admin/videos/import-from-drive
 * ボディ:
 *   - driveUrl: string (必須) Google DriveのURL
 *   - lessonId: string (必須) 対象レッスンID
 *   - durationSec: number (必須) 動画の再生時間（秒）
 *   - requiredWatchRatio?: number
 *   - speedLock?: boolean
 */
router.post("/admin/videos/import-from-drive", requireAdmin, async (req: Request, res: Response) => {
  if (!isWorkspaceIntegrationAvailable()) {
    res.status(503).json({
      error: "workspace_not_configured",
      message: "Google Workspace integration is not configured",
    });
    return;
  }

  const ds = req.dataSource!;
  const tenantId = req.tenantContext!.tenantId;
  const { driveUrl, lessonId, durationSec, requiredWatchRatio, speedLock } = req.body;

  // バリデーション
  if (!driveUrl || typeof driveUrl !== "string") {
    res.status(400).json({ error: "invalid_driveUrl", message: "driveUrl is required" });
    return;
  }
  if (!lessonId || typeof lessonId !== "string") {
    res.status(400).json({ error: "invalid_lessonId", message: "lessonId is required" });
    return;
  }
  if (durationSec === undefined || durationSec === null || typeof durationSec !== "number") {
    res.status(400).json({ error: "invalid_durationSec", message: "durationSec is required and must be a number" });
    return;
  }

  // DriveURL解析
  let fileId: string;
  try {
    fileId = parseDriveUrl(driveUrl);
  } catch {
    res.status(400).json({ error: "invalid_driveUrl", message: "Invalid Google Drive URL format" });
    return;
  }

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

  // Driveファイルメタデータ検証
  let metadata: { name: string; mimeType: string; size: string };
  try {
    metadata = await getDriveFileMetadata(fileId);
    validateDriveFileMetadata(metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to validate Drive file";
    res.status(400).json({ error: "drive_file_invalid", message });
    return;
  }

  // Videoレコード作成 (importStatus=pending)
  const video = await ds.createVideo({
    lessonId,
    courseId: lesson.courseId,
    sourceType: "google_drive",
    driveFileId: fileId,
    importStatus: "pending",
    durationSec,
    requiredWatchRatio: requiredWatchRatio ?? 0.95,
    speedLock: speedLock ?? true,
  });

  // 非同期でDrive→GCSコピー開始
  // hasVideoはインポート完了後に設定（エラー時は巻き戻し不要にする）
  (async () => {
    try {
      await ds.updateVideo(video.id, { importStatus: "importing" });
      const { gcsPath } = await copyDriveFileToGCS(fileId, tenantId, metadata);
      await ds.updateVideo(video.id, {
        gcsPath,
        importStatus: "completed",
      });
      // インポート完了後にhasVideoをtrueに設定
      await ds.updateLesson(lessonId, { hasVideo: true });
    } catch (error) {
      // エラーハンドラ: 状態復旧を最優先
      const message = error instanceof Error ? error.message : "Unknown import error";
      console.error(`Drive import failed for video ${video.id}:`, message);

      try {
        // transient/permanent分類
        const isTransient = error instanceof Error &&
          ("status" in error && [429, 503].includes((error as { status: number }).status));

        await ds.updateVideo(video.id, {
          importStatus: isTransient ? "pending" : "error",
          importError: message,
        });
      } catch (updateError) {
        console.error(`Failed to update import status for video ${video.id}:`, updateError);
      }
    }
  })();

  // 202 Accepted: インポートは非同期で進行
  res.status(202).json({
    video: {
      id: video.id,
      lessonId: video.lessonId,
      courseId: video.courseId,
      sourceType: video.sourceType,
      driveFileId: video.driveFileId,
      importStatus: video.importStatus,
      durationSec: video.durationSec,
      requiredWatchRatio: video.requiredWatchRatio,
      speedLock: video.speedLock,
      createdAt: video.createdAt,
    },
    message: "Video import started. Poll /admin/videos/:videoId/import-status for progress.",
  });
});

/**
 * インポートステータス確認
 * GET /admin/videos/:videoId/import-status
 */
router.get("/admin/videos/:videoId/import-status", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const videoId = req.params.videoId as string;

  const video = await ds.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: "not_found", message: "Video not found" });
    return;
  }

  res.json({
    videoId: video.id,
    sourceType: video.sourceType,
    importStatus: video.importStatus ?? null,
    importError: video.importError ?? null,
    gcsPath: video.gcsPath ?? null,
  });
});

export const googleDriveImportRouter = router;
