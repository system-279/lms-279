/**
 * Google Drive動画インポートのビジネスロジック
 * shared routes と super-admin-master の両方から呼ばれる
 */

import type { DataSource } from "../datasource/interface.js";
import type { Video } from "../types/entities.js";
import {
  parseDriveUrl,
  getDriveFileMetadata,
  validateDriveFileMetadata,
  copyDriveFileToGCS,
} from "./google-drive.js";

export interface DriveImportInput {
  driveUrl: string;
  lessonId: string;
  durationSec?: number;
  requiredWatchRatio?: number;
  speedLock?: boolean;
}

export interface DriveImportValidationError {
  error: string;
  message: string;
  status: number;
}

export interface DriveImportResult {
  video: Video;
  metadata: { name: string; mimeType: string; size: string };
  fileId: string;
}

/**
 * Drive URLのバリデーション、メタデータ検証、Videoレコード作成を行う
 * 非同期コピーは開始しない（呼び出し元が startAsyncCopy を呼ぶ）
 */
export async function prepareDriveImport(
  ds: DataSource,
  input: DriveImportInput,
  options: { replaceExisting?: boolean } = {}
): Promise<DriveImportResult | DriveImportValidationError> {
  const { driveUrl, lessonId, durationSec, requiredWatchRatio, speedLock } = input;

  // バリデーション
  if (!driveUrl || typeof driveUrl !== "string") {
    return { error: "invalid_driveUrl", message: "driveUrl is required", status: 400 };
  }
  if (!lessonId || typeof lessonId !== "string") {
    return { error: "invalid_lessonId", message: "lessonId is required", status: 400 };
  }
  if (durationSec !== undefined && typeof durationSec !== "number") {
    return { error: "invalid_durationSec", message: "durationSec must be a number", status: 400 };
  }

  // Drive URL解析
  let fileId: string;
  try {
    fileId = parseDriveUrl(driveUrl);
  } catch {
    return { error: "invalid_driveUrl", message: "Invalid Google Drive URL format", status: 400 };
  }

  // レッスン存在チェック
  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    return { error: "not_found", message: "Lesson not found", status: 404 };
  }

  // 既存動画チェック
  const existing = await ds.getVideoByLessonId(lessonId);
  if (existing) {
    if (options.replaceExisting) {
      await ds.deleteVideo(existing.id);
    } else {
      return { error: "video_already_exists", message: "A video already exists for this lesson", status: 409 };
    }
  }

  // Driveファイルメタデータ検証
  let metadata: { name: string; mimeType: string; size: string };
  try {
    metadata = await getDriveFileMetadata(fileId);
    validateDriveFileMetadata(metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to validate Drive file";
    return { error: "drive_file_invalid", message, status: 400 };
  }

  // Videoレコード作成
  const video = await ds.createVideo({
    lessonId,
    courseId: lesson.courseId,
    sourceType: "google_drive",
    driveFileId: fileId,
    importStatus: "pending",
    durationSec: durationSec ?? 0,
    requiredWatchRatio: requiredWatchRatio ?? 0.95,
    speedLock: speedLock ?? true,
  });

  return { video, metadata, fileId };
}

/**
 * 型ガード: バリデーションエラーかどうか
 */
export function isValidationError(
  result: DriveImportResult | DriveImportValidationError
): result is DriveImportValidationError {
  return "status" in result;
}

/**
 * 非同期でDrive→GCSコピーを開始（fire-and-forget）
 * hasVideoはインポート完了後に設定
 */
export function startAsyncDriveCopy(
  ds: DataSource,
  videoId: string,
  lessonId: string,
  fileId: string,
  tenantId: string,
  metadata: { name: string; mimeType: string; size: string }
): void {
  (async () => {
    try {
      await ds.updateVideo(videoId, { importStatus: "importing" });
      const { gcsPath } = await copyDriveFileToGCS(fileId, tenantId, metadata);
      await ds.updateVideo(videoId, {
        gcsPath,
        importStatus: "completed",
      });
      await ds.updateLesson(lessonId, { hasVideo: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import error";
      console.error(`Drive import failed for video ${videoId}:`, message);

      try {
        const isTransient = error instanceof Error &&
          ("status" in error && [429, 503].includes((error as { status: number }).status));

        await ds.updateVideo(videoId, {
          importStatus: isTransient ? "pending" : "error",
          importError: message,
        });
      } catch (updateError) {
        console.error(`Failed to update import status for video ${videoId}:`, updateError);
      }
    }
  })();
}
