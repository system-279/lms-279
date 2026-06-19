/**
 * 講座資料スライド PDF 配信サービス
 *
 * - super-admin がマスターレッスン (`_master`) に PDF をアップロード/差し替え/削除
 * - 受講者は当該レッスンのテスト合格 + 受講期間内に限り PDF をダウンロード
 * - GCS は新規バケット `lms-279-resources` を使用、ファイル本体は全テナントで共有
 *
 * 設計詳細: docs/specs/2026-05-17-course-pdf-download-design.md
 */

import { randomUUID } from "node:crypto";
import type { Storage } from "@google-cloud/storage";
import type { DataSource } from "../datasource/interface.js";
import type { Lesson } from "../types/entities.js";
import type {
  LessonResource,
  LessonPdfDownloadResponse,
  LessonPdfUploadUrlResponse,
} from "@lms-279/shared-types";
import { logger } from "../utils/logger.js";
import { isTransientError, retryOnTransient } from "../utils/transient-error.js";

export const PDF_MIME_TYPE = "application/pdf";
export const MAX_PDF_SIZE_BYTES = 300 * 1024 * 1024; // 300 MB
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
 * GCS / IAM Credentials API 呼び出しを transient リトライで包む。
 *
 * - transient (HTTP 429/500/502/503/504 + transport code + `Premature close` 等の
 *   message パターン) は bounded retry (最大 2 attempts) → それでも失敗したら
 *   `gcs_unavailable` に変換。
 * - permanent エラーは即時 throw (上位で LessonResourceError 等の判別に進む)。
 *
 * 2026-06-19 本番障害: IAM Credentials API `signBlob` が `Premature close` で失敗し、
 * 旧実装は `timeout|ECONNRESET` のみ判定でこれを素通りさせていた。
 * `services/api/src/utils/transient-error.ts` の `isTransientError` で一元判定する。
 *
 * 副作用なし / idempotent な op (署名 URL 生成、メタデータ取得) にのみ使う。
 */
async function withGcsErrorMapping<T>(op: () => Promise<T>, context: string): Promise<T> {
  try {
    return await retryOnTransient(op, {
      maxAttempts: 2,
      baseDelayMs: 150,
      onRetry: ({ attempt, error, delayMs }) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("gcs_transient_retry", { context, attempt, delayMs, message });
      },
    });
  } catch (e) {
    if (isTransientError(e)) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("gcs_transient_error", { context, message });
      throw new LessonResourceError("gcs_unavailable", "一時的に処理できません。再度お試しください");
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
    throw new LessonResourceError("file_too_large", "300 MB を超えるファイルはアップロードできません");
  }

  const lesson = await ds.getLessonById(masterLessonId);
  if (!lesson) {
    throw new LessonResourceError("lesson_not_found", "対象レッスンが見つかりません");
  }

  const sanitized = sanitizeFileName(fileName);
  if (!sanitized || !sanitized.toLowerCase().endsWith(".pdf")) {
    throw new LessonResourceError("invalid_file_type", "ファイル名が無効です");
  }

  // path 衝突防止: Date.now() に加えて UUID を含める (Codex 指摘の race condition 対策)
  const gcsPath = `lessons/${masterLessonId}/${Date.now()}_${randomUUID()}_${sanitized}`;
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
    throw new LessonResourceError("file_too_large", "300 MB を超えるファイルはアップロードできません");
  }

  const lesson = await ds.getLessonById(masterLessonId);
  if (!lesson) {
    throw new LessonResourceError("lesson_not_found", "対象レッスンが見つかりません");
  }

  // GCS object の実メタデータを検証 (Codex 指摘: クライアント値だけでは不足)。
  // 漏洩した署名 URL や誤操作で 300 MB 超 / 非 PDF を upload しても、ここで弾く。
  const file = storage.bucket(RESOURCE_BUCKET()).file(gcsPath);
  let metadata: { size?: string | number; contentType?: string };
  try {
    const [m] = await file.getMetadata();
    metadata = m;
  } catch (e) {
    const error = e as { code?: number };
    if (error.code === 404) {
      throw new LessonResourceError("gcs_file_missing", "アップロードファイルが見つかりません");
    }
    throw e;
  }
  const actualSize =
    typeof metadata.size === "string" ? Number(metadata.size) : (metadata.size ?? 0);
  if (!Number.isFinite(actualSize) || actualSize <= 0 || actualSize > MAX_PDF_SIZE_BYTES) {
    // 不正な実サイズは object を消してから 400
    await file.delete().catch(() => undefined);
    throw new LessonResourceError("file_too_large", "アップロード済みファイルが上限を超えています");
  }
  if (metadata.contentType && metadata.contentType !== PDF_MIME_TYPE) {
    await file.delete().catch(() => undefined);
    throw new LessonResourceError("invalid_file_type", "PDF ファイル以外がアップロードされています");
  }

  // 旧 GCS object は即削除しない (Codex 指摘の High #1):
  // ADR-024 / ADR-036 に基づき GCS path は全テナントで共有しているため、マスター差し替え時に
  // 即削除すると配信済みテナントの受講者が 404 になる。orphan として残し、別途 cleanup ジョブで
  // 全テナント参照が消えたタイミングで削除する (本 PR スコープ外、フォローアップ Issue 候補)。
  const pdfUpdatedAt = new Date().toISOString();
  await ds.updateLesson(masterLessonId, {
    pdfGcsPath: gcsPath,
    pdfFileName: fileName,
    pdfSizeBytes: actualSize,
    pdfUpdatedAt,
  });

  logger.info("pdf_uploaded", { masterLessonId, gcsPath, sizeBytes: actualSize });

  return { pdfFileName: fileName, pdfSizeBytes: actualSize, pdfUpdatedAt };
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
  // 現状の DataSource interface は空文字書き込み相当で表現する (FieldValue.delete 完全化は
  // フォローアップ Issue 候補)。受講者 GET 側で `lesson.pdfGcsPath` falsy 判定で 404 返す。
  await ds.updateLesson(masterLessonId, {
    pdfGcsPath: "",
    pdfFileName: "",
    pdfSizeBytes: 0,
    pdfUpdatedAt: new Date().toISOString(),
  });

  // GCS object は即削除しない (Codex 指摘の High #1):
  // ADR-024 / ADR-036 に基づき GCS path は全テナントで共有しているため、マスター削除時に
  // 即 GCS object を消すと、配信済みテナントの受講者が 404 になる。
  // 配信済みコース側で `sync-resources` を実行することでメタが空文字化され、テナント側でも
  // 段階的に DL ボタンが hide される。GCS object 自体は別途 cleanup ジョブで全テナント
  // 参照が消えてから削除する (本 PR スコープ外)。
  void storage; // 引数互換維持 (現状は使わない)、将来 cleanup 経路で活用
  logger.info("pdf_metadata_cleared", { masterLessonId, previousGcsPath });
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

  // コース status チェック (Codex 指摘 Medium #4):
  // lessonId 直指定で archived/draft コースの PDF が DL できる迂回路を塞ぐ。
  // `/courses/:id` 経由でなくても、ここで status を必ず確認する。
  const course = await ds.getCourseById(lesson.courseId);
  if (!course || course.status !== "published") {
    // 列挙対策で lesson_not_found に統一 (course の状態を漏らさない)
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
