/**
 * Google Drive動画インポートルーター
 * Drive URLから動画をGCSにコピーし、既存の署名付きURL再生フローで配信
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { isWorkspaceIntegrationAvailable } from "../../services/google-auth.js";
import {
  prepareDriveImport,
  isValidationError,
  startAsyncDriveCopy,
} from "../../services/drive-import.js";

const router = Router();

/**
 * Google Driveから動画をインポート
 * POST /admin/videos/import-from-drive
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

  const result = await prepareDriveImport(ds, req.body);
  if (isValidationError(result)) {
    res.status(result.status).json({ error: result.error, message: result.message });
    return;
  }

  const { video, metadata, fileId } = result;
  startAsyncDriveCopy(ds, video.id, video.lessonId, fileId, tenantId, metadata);

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
