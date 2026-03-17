import { Storage } from "@google-cloud/storage";

const storage = new Storage();
const VIDEO_BUCKET = process.env.GCS_VIDEO_BUCKET || "lms-279-videos";
const UPLOAD_BUCKET = process.env.GCS_UPLOAD_BUCKET || "lms-279-uploads";

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
  const [url] = await storage.bucket(UPLOAD_BUCKET).file(gcsPath).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 60 * 60 * 1000, // 1時間有効
    contentType,
  });
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
  const [url] = await storage.bucket(VIDEO_BUCKET).file(gcsPath).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 2 * 60 * 60 * 1000, // 2時間有効
  });
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
