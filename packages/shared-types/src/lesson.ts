/**
 * レッスン関連の共有レスポンス型
 */

/**
 * 講座資料スライド PDF のメタ情報。
 * GET /:tenant/lessons/:id 等のレスポンスに `resource?: LessonResource` として含まれる。
 * pdfGcsPath は内部実装の露出を避けるため受講者向けレスポンスには含めない。
 */
export interface LessonResource {
  pdfFileName: string;
  pdfSizeBytes: number;
  pdfUpdatedAt: string;
}

/**
 * GET /:tenant/lessons/:lessonId/pdf-download のレスポンス。
 * 短期署名 URL (15 分有効) を含む。
 */
export interface LessonPdfDownloadResponse {
  url: string;
  fileName: string;
  expiresAt: string;
}

/**
 * POST /master/lessons/:lessonId/pdf-upload-url のレスポンス。
 * 署名 PUT URL (1 時間有効) と GCS パスを含む。
 */
export interface LessonPdfUploadUrlResponse {
  uploadUrl: string;
  gcsPath: string;
  expiresAt: string;
}
