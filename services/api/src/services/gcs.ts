import { Storage } from "@google-cloud/storage";
import { logger } from "../utils/logger.js";
import { retryOnTransient } from "../utils/transient-error.js";

const storage = new Storage();
const VIDEO_BUCKET = process.env.GCS_VIDEO_BUCKET || "lms-279-videos";
const UPLOAD_BUCKET = process.env.GCS_UPLOAD_BUCKET || "lms-279-uploads";

/**
 * GCS V4 署名 URL 生成 (内部で IAM Credentials API `signBlob` を呼ぶ) を
 * transient リトライで包む共通ヘルパー。
 *
 * 2026-06-19 本番障害 (再発): 動画再生 URL 生成の `signBlob` が
 * `Premature close` (transient な TCP 早期切断) で失敗し、
 * `GET /videos/:id/playback-url` が 500 を返して受講者が動画を開けなかった
 * (赤背景に `[object Object]` 表示)。Session 78 (#579) では PDF 署名
 * (lesson-resource.ts) のみ retry 化し、動画署名 (本ファイル) への適用が漏れていた。
 *
 * 署名 URL 生成は副作用なし / idempotent なので bounded retry が安全。
 * transient 判定は utils/transient-error.ts の isTransientError に一元化
 * (`premature close` を含む message パターン + transport code + HTTP status)。
 * playback-url は受講者をブロックする critical path のため、PDF 署名 (2 attempts)
 * より 1 回多い 3 attempts で回復率を上げる。
 */
async function withSigningRetry<T>(op: () => Promise<T>, context: string): Promise<T> {
  return retryOnTransient(op, {
    maxAttempts: 3,
    baseDelayMs: 150,
    onRetry: ({ attempt, error, delayMs }) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("gcs_signing_transient_retry", { context, attempt, delayMs, message });
    },
  });
}

/**
 * 動画アップロード用の署名付きURL生成
 * 管理者が直接GCSにアップロードするためのPUT URL
 * @param fileName アップロードファイル名
 * @param contentType MIMEタイプ (video/mp4等)
 * @param tenantId テナントID
 * @returns { uploadUrl: string, gcsPath: string }
 */
export async function generateUploadUrl(
  fileName: string,
  contentType: string,
  tenantId: string
): Promise<{ uploadUrl: string; gcsPath: string }> {
  const gcsPath = `${tenantId}/videos/${Date.now()}_${fileName}`;
  const expires = Date.now() + 60 * 60 * 1000; // 1時間有効
  const [url] = await withSigningRetry(
    () =>
      storage.bucket(UPLOAD_BUCKET).file(gcsPath).getSignedUrl({
        version: "v4",
        action: "write",
        expires,
        contentType,
      }),
    "generateUploadUrl",
  );
  return { uploadUrl: url, gcsPath };
}

/**
 * アップロードバケットからビデオバケットにファイルを移動
 * アップロード完了後に呼び出す
 */
export async function moveToVideoBucket(
  uploadGcsPath: string
): Promise<string> {
  const videoGcsPath = uploadGcsPath; // 同じパス構造を維持
  await storage
    .bucket(UPLOAD_BUCKET)
    .file(uploadGcsPath)
    .move(storage.bucket(VIDEO_BUCKET).file(videoGcsPath));
  return videoGcsPath;
}

/**
 * 動画再生用の署名付きURL生成
 * 受講者が動画を視聴するためのGET URL
 * @param gcsPath GCS上のファイルパス
 * @returns 署名付きURL（2時間有効）
 */
export async function generatePlaybackUrl(gcsPath: string): Promise<string> {
  const expires = Date.now() + 2 * 60 * 60 * 1000; // 2時間有効
  const [url] = await withSigningRetry(
    () =>
      storage.bucket(VIDEO_BUCKET).file(gcsPath).getSignedUrl({
        version: "v4",
        action: "read",
        expires,
      }),
    "generatePlaybackUrl",
  );
  return url;
}

/**
 * GCSから動画ファイルを削除
 */
export async function deleteVideoFile(gcsPath: string): Promise<void> {
  try {
    await storage.bucket(VIDEO_BUCKET).file(gcsPath).delete();
  } catch (error: unknown) {
    // ファイルが存在しない場合は無視
    if (error && typeof error === "object" && "code" in error && (error as { code: number }).code === 404) {
      return;
    }
    throw error;
  }
}
