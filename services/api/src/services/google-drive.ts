import { Storage } from "@google-cloud/storage";
import { getDriveClient } from "./google-auth.js";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const storage = new Storage();
const VIDEO_BUCKET = process.env.GCS_VIDEO_BUCKET || "lms-279-videos";
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

/**
 * Google DriveのURLからファイルIDを抽出
 * 対応形式:
 *   - https://drive.google.com/file/d/{fileId}/view
 *   - https://drive.google.com/file/d/{fileId}/view?usp=sharing
 *   - https://drive.google.com/file/d/{fileId}/edit
 *   - https://drive.google.com/file/d/{fileId}
 *   - https://drive.google.com/open?id={fileId}
 */
export function parseDriveUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "drive.google.com") {
      throw new Error("Invalid Google Drive URL");
    }
  } catch {
    throw new Error("Invalid Google Drive URL");
  }

  // /file/d/{fileId}/ パターン
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) {
    return fileMatch[1];
  }

  // /open?id={fileId} パターン
  const openMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch) {
    return openMatch[1];
  }

  throw new Error("Invalid Google Drive URL");
}

/**
 * Driveファイルのメタデータを検証
 * - 動画ファイルであること (video/*)
 * - サイズが5GB以下であること
 */
export function validateDriveFileMetadata(metadata: {
  mimeType: string;
  size: string;
  name: string;
}): void {
  if (!metadata.mimeType.startsWith("video/")) {
    throw new Error(
      `"${metadata.name}" is not a video file (type: ${metadata.mimeType})`
    );
  }

  const sizeBytes = parseInt(metadata.size, 10);
  if (sizeBytes > MAX_FILE_SIZE) {
    const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(1);
    throw new Error(
      `"${metadata.name}" (${sizeGB}GB) exceeds the 5GB limit`
    );
  }
}

/**
 * Google Driveファイルのメタデータを取得
 */
export async function getDriveFileMetadata(fileId: string): Promise<{
  name: string;
  mimeType: string;
  size: string;
  durationSec: number | null;
}> {
  const drive = await getDriveClient();
  const response = await drive.files.get({
    fileId,
    fields: "name,mimeType,size,videoMediaMetadata",
    supportsAllDrives: true,
  });

  const { name, mimeType, size, videoMediaMetadata } = response.data;
  if (!name || !mimeType || !size) {
    throw new Error("Failed to retrieve file metadata from Google Drive");
  }

  const durationMs = videoMediaMetadata?.durationMillis;
  const durationSec = durationMs ? Math.round(Number(durationMs) / 1000) : null;

  return { name, mimeType, size, durationSec };
}

/**
 * Google DriveからGCSに動画ファイルをストリームコピー
 * メモリバッファを使わず、ストリームパイプラインで転送
 *
 * @param fileId Google DriveのファイルID
 * @param tenantId テナントID (GCSパスの名前空間に使用)
 * @returns GCS上のファイルパス
 */
export async function copyDriveFileToGCS(
  fileId: string,
  tenantId: string,
  preloadedMetadata?: { name: string; mimeType: string; size: string; durationSec: number | null }
): Promise<{ gcsPath: string; fileName: string }> {
  const drive = await getDriveClient();

  // メタデータ取得 & 検証（事前取得済みの場合はスキップ）
  const metadata = preloadedMetadata ?? await getDriveFileMetadata(fileId);
  if (!preloadedMetadata) {
    validateDriveFileMetadata(metadata);
  }

  // Drive からストリーム取得
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );

  const gcsPath = `${tenantId}/videos/${Date.now()}_drive_${metadata.name}`;
  const gcsFile = storage.bucket(VIDEO_BUCKET).file(gcsPath);
  const writeStream = gcsFile.createWriteStream({
    contentType: metadata.mimeType,
    resumable: true,
  });

  // ストリームパイプライン: Drive → GCS
  await pipeline(response.data as Readable, writeStream);

  return { gcsPath, fileName: metadata.name };
}
