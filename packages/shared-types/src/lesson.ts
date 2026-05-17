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

/**
 * POST /master/lessons/:lessonId/pdf のレスポンス。
 * confirm 後に Firestore メタ書込み済みの lesson resource を返す。
 */
export interface LessonPdfConfirmResponse {
  resource: LessonResource;
}

/**
 * POST /master/courses/:courseId/sync-resources のレスポンス。
 * 既存配信先テナントへの PDF メタ遡及反映の結果を返す (ADR-036)。
 *
 * - tenantsCount: メタ更新が発生したテナント数 (配信済みかつ何らかの lesson が touch されたもの)
 * - lessonsCount: PDF メタが追加/更新された lesson 数 (累計、全テナント横断)
 * - removedCount: master 側 PDF 削除に伴い tenant 側メタがクリアされた lesson 数
 */
export interface SyncResourcesResponse {
  tenantsCount: number;
  lessonsCount: number;
  removedCount: number;
}
