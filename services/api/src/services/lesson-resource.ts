/**
 * 講座資料スライド PDF 配信サービス
 *
 * - super-admin がマスターレッスン (`_master`) に PDF をアップロード/差し替え/削除
 * - 受講者は当該レッスンのテスト合格 + 受講期間内に限り PDF をダウンロード
 * - GCS は新規バケット `lms-279-resources` を使用、ファイル本体は全テナントで共有
 *
 * 設計詳細: docs/specs/2026-05-17-course-pdf-download-design.md
 */

import type { Storage } from "@google-cloud/storage";
import type { DataSource } from "../datasource/interface.js";
import type { Lesson } from "../types/entities.js";
import type {
  LessonResource,
  LessonPdfDownloadResponse,
  LessonPdfUploadUrlResponse,
} from "@lms-279/shared-types";
import { logger } from "../utils/logger.js";

export const PDF_MIME_TYPE = "application/pdf";
export const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const UPLOAD_URL_EXPIRES_MS = 60 * 60 * 1000; // 1 時間
const DOWNLOAD_URL_EXPIRES_MS = 15 * 60 * 1000; // 15 分

export class LessonResourceError extends Error {
  constructor(
    public readonly code:
      | "invalid_file_type"
      | "file_too_large"
      | "lesson_not_found"
      | "quiz_not_passed"
      | "access_expired"
      | "resource_not_found"
      | "gcs_unavailable"
      | "gcs_file_missing",
    message: string,
  ) {
    super(message);
    this.name = "LessonResourceError";
  }
}

const RESOURCE_BUCKET = (): string =>
  process.env.GCS_RESOURCE_BUCKET || "lms-279-resources";

/**
 * Path traversal を防ぐためファイル名を sanitize する。
 * basename のみ抽出し、ASCII 制御文字と path separator を除去。
 * 日本語 / スペースは許可 (Content-Disposition で正しくエンコードされる前提)。
 */
function sanitizeFileName(fileName: string): string {
  const basename = fileName.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return basename.replace(/[\x00-\x1f]/g, "").trim();
}

/**
 * GCS API 呼び出しを安全に包む。一時的エラー (503/429/timeout) は gcs_unavailable に変換。
 */
async function withGcsErrorMapping<T>(op: () => Promise<T>, context: string): Promise<T> {
  try {
    return await op();
  } catch (e) {
    const error = e as { code?: number; message?: string };
    const status = typeof error.code === "number" ? error.code : 0;
    if (status === 429 || status === 503 || /timeout|ECONNRESET/i.test(error.message ?? "")) {
      logger.error("gcs_transient_error", { context, status, message: error.message });
      throw new LessonResourceError("gcs_unavailable", "一時的に取得できません");
    }
    throw e;
  }
}

/**
 * super-admin 用: PDF アップロード用の署名 PUT URL を生成する。
 *
 * `_master` テナントの DataSource を渡すこと。
 */
export async function generatePdfUploadUrl(
  ds: DataSource,
  storage: Storage,
  masterLessonId: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): Promise<LessonPdfUploadUrlResponse> {
  if (contentType !== PDF_MIME_TYPE) {
    throw new LessonResourceError("invalid_file_type", "PDF ファイルのみアップロード可能です");
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PDF_SIZE_BYTES) {
    throw new LessonResourceError("file_too_large", "50 MB を超えるファイルはアップロードできません");
  }

  const lesson = await ds.getLessonById(masterLessonId);
  if (!lesson) {
    throw new LessonResourceError("lesson_not_found", "対象レッスンが見つかりません");
  }

  const sanitized = sanitizeFileName(fileName);
  if (!sanitized || !sanitized.toLowerCase().endsWith(".pdf")) {
    throw new LessonResourceError("invalid_file_type", "ファイル名が無効です");
  }

  const gcsPath = `lessons/${masterLessonId}/${Date.now()}_${sanitized}`;
  const expiresAt = new Date(Date.now() + UPLOAD_URL_EXPIRES_MS);

  const [uploadUrl] = await withGcsErrorMapping(
    () =>
      storage.bucket(RESOURCE_BUCKET()).file(gcsPath).getSignedUrl({
        version: "v4",
        action: "write",
        expires: expiresAt.getTime(),
        contentType,
      }),
    "generatePdfUploadUrl",
  );

  return { uploadUrl, gcsPath, expiresAt: expiresAt.toISOString() };
}

/**
 * super-admin 用: アップロード完了確認 + Firestore メタ書き込み。
 *
 * `_master` テナントの DataSource を渡すこと。
 * 既存 PDF があれば、新メタ書き込み後に旧 GCS ファイルを削除する (上書き)。
 */
export async function confirmPdfUpload(
  ds: DataSource,
  storage: Storage,
  masterLessonId: string,
  gcsPath: string,
  fileName: string,
  sizeBytes: number,
): Promise<LessonResource> {
  // CRITICAL: gcsPath のプレフィックス検証 (Evaluator 指摘、列挙/バケット横断攻撃対策)
  // generatePdfUploadUrl が返したパス形式 `lessons/{masterLessonId}/...` のみ受け付ける
  if (!gcsPath.startsWith(`lessons/${masterLessonId}/`)) {
    throw new LessonResourceError("invalid_file_type", "GCS パスが不正です");
  }
  // sizeBytes の再検証 (Evaluator 指摘、upload-url と confirm 間で乖離する可能性)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PDF_SIZE_BYTES) {
    throw new LessonResourceError("file_too_large", "50 MB を超えるファイルはアップロードできません");
  }

  const lesson = await ds.getLessonById(masterLessonId);
  if (!lesson) {
    throw new LessonResourceError("lesson_not_found", "対象レッスンが見つかりません");
  }

  const [exists] = await withGcsErrorMapping(
    () => storage.bucket(RESOURCE_BUCKET()).file(gcsPath).exists(),
    "confirmPdfUpload.exists",
  );
  if (!exists) {
    throw new LessonResourceError("gcs_file_missing", "アップロードファイルが見つかりません");
  }

  const previousGcsPath = lesson.pdfGcsPath;
  const pdfUpdatedAt = new Date().toISOString();
  await ds.updateLesson(masterLessonId, {
    pdfGcsPath: gcsPath,
    pdfFileName: fileName,
    pdfSizeBytes: sizeBytes,
    pdfUpdatedAt,
  });

  if (previousGcsPath && previousGcsPath !== gcsPath) {
    try {
      await storage.bucket(RESOURCE_BUCKET()).file(previousGcsPath).delete();
    } catch (e) {
      logger.error("pdf_old_object_delete_failed", {
        masterLessonId,
        previousGcsPath,
        error: (e as Error).message,
      });
    }
  }

  logger.info("pdf_uploaded", { masterLessonId, gcsPath, sizeBytes });

  return { pdfFileName: fileName, pdfSizeBytes: sizeBytes, pdfUpdatedAt };
}

/**
 * super-admin 用: マスターレッスンの PDF を削除。
 *
 * 状態復旧 (Firestore メタ削除) を最優先。GCS 削除失敗時は orphan として残り、
 * 後続の cleanup ジョブで対応可能。
 */
export async function deletePdfResource(
  ds: DataSource,
  storage: Storage,
  masterLessonId: string,
): Promise<void> {
  const lesson = await ds.getLessonById(masterLessonId);
  if (!lesson) {
    throw new LessonResourceError("lesson_not_found", "対象レッスンが見つかりません");
  }
  if (!lesson.pdfGcsPath) {
    throw new LessonResourceError("resource_not_found", "このレッスンには資料が登録されていません");
  }

  const previousGcsPath = lesson.pdfGcsPath;

  // Firestore メタ削除 (最優先)
  // sentinel として undefined を渡しても applyUpdate で除去されてしまうため、
  // FirestoreDataSource では set(merge: true) ではなく明示的に空文字を一旦書いてから
  // FieldValue.delete() を使う方式が望ましいが、本実装では「pdfGcsPath を空文字に
  // 書き換える」までを Wave 3 とし、削除完全化は Wave 4 でルート層に FieldValue.delete()
  // を組み込むか、DataSource interface を拡張する方針とする。
  // 現状: pdfGcsPath を空文字に上書き → 受講者 GET 側で `lesson.pdfGcsPath` falsy で 404 返す。
  await ds.updateLesson(masterLessonId, {
    pdfGcsPath: "",
    pdfFileName: "",
    pdfSizeBytes: 0,
    pdfUpdatedAt: new Date().toISOString(),
  });

  // GCS 削除 (失敗は orphan ログのみ)
  try {
    await storage.bucket(RESOURCE_BUCKET()).file(previousGcsPath).delete();
  } catch (e) {
    logger.error("pdf_gcs_delete_failed_orphan", {
      masterLessonId,
      previousGcsPath,
      error: (e as Error).message,
    });
  }

  logger.info("pdf_deleted", { masterLessonId, previousGcsPath });
}

/**
 * 受講者向け DL URL を生成する。認可チェックを内包する。
 *
 * テナント別の DataSource を渡すこと。
 * 認可順序: lesson 存在確認 → quizPassed 確認 → videoAccessUntil 確認 → pdf 添付確認。
 * すべて pass したら 15 分有効の署名 URL を返す。
 *
 * 列挙攻撃対策: lesson 不在は 404、それ以外は具体的なコードを返す (上位ルートが整形)。
 */
export async function generatePdfDownloadUrl(
  ds: DataSource,
  storage: Storage,
  lessonId: string,
  userId: string,
): Promise<LessonPdfDownloadResponse> {
  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    throw new LessonResourceError("lesson_not_found", "対象レッスンが見つかりません");
  }

  const progress = await ds.getUserProgress(userId, lessonId);
  if (!progress || progress.quizPassed !== true) {
    throw new LessonResourceError("quiz_not_passed", "テスト合格後にダウンロード可能です");
  }

  const setting = await ds.getTenantEnrollmentSetting();
  // 仕様: 受講期間設定がないテナントは DL 不可 (Evaluator 指摘、default close 設計で
  // 未設定テナントが無制限にダウンロードできる穴を塞ぐ)。
  if (!setting || new Date(setting.videoAccessUntil).getTime() <= Date.now()) {
    throw new LessonResourceError("access_expired", "受講期間が終了しています");
  }

  if (!lesson.pdfGcsPath || !lesson.pdfFileName) {
    throw new LessonResourceError(
      "resource_not_found",
      "このレッスンには資料が登録されていません",
    );
  }

  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRES_MS);
  const [url] = await withGcsErrorMapping(
    () =>
      storage.bucket(RESOURCE_BUCKET()).file(lesson.pdfGcsPath!).getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAt.getTime(),
        responseDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(lesson.pdfFileName!)}`,
      }),
    "generatePdfDownloadUrl",
  );

  logger.info("pdf_downloaded", { lessonId, userId });

  return { url, fileName: lesson.pdfFileName, expiresAt: expiresAt.toISOString() };
}

/**
 * 受講者向け表示用に Lesson から LessonResource (公開 DTO) を抽出する。
 * pdfGcsPath は内部実装の露出を避けるため除外。PDF 未添付の場合は undefined を返す。
 */
export function toLessonResource(lesson: Pick<Lesson, "pdfGcsPath" | "pdfFileName" | "pdfSizeBytes" | "pdfUpdatedAt">): LessonResource | undefined {
  if (!lesson.pdfGcsPath || !lesson.pdfFileName || !lesson.pdfSizeBytes || !lesson.pdfUpdatedAt) {
    return undefined;
  }
  return {
    pdfFileName: lesson.pdfFileName,
    pdfSizeBytes: lesson.pdfSizeBytes,
    pdfUpdatedAt: lesson.pdfUpdatedAt,
  };
}
