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
 * 講座資料PDFのダウンロード可否（テスト任意化 Stage 4）。
 * - allowed: ダウンロード可能（合格 OR (スキップ済み AND テナントが許可)）
 * - needs_quiz_pass: テスト未受験・未合格（かつ未スキップ）
 * - blocked_by_skip: スキップ済みだが、このテナントではスキップ者への PDF ダウンロードを許可していない
 *
 * スコープ注意: この型はテスト受験状態のみに基づく判定であり、受講期間切れ
 * (`videoAccessUntil` 経過) は含まない。受講期間切れの表示制御は別軸の
 * `videoAccessExpired` (boolean) と組み合わせて判定すること
 * (`LessonPdfButton` は resource 未添付・期間切れを本型より先に判定する)。
 */
export type PdfDownloadEligibility = "allowed" | "needs_quiz_pass" | "blocked_by_skip";

/**
 * GET /:tenant/lessons/:lessonId のレスポンス（受講者向け）。
 * `lesson` は services/api の `Lesson` entity のうち受講者向けに安全なフィールドのみを
 * 抜粋したもの（`pdfGcsPath` 等の内部専用フィールドは意図的に除外）。
 * entity にフィールドを追加した場合はこちらの対応要否も確認すること。
 */
export interface StudentLessonDetailResponse {
  lesson: {
    id: string;
    courseId: string;
    title: string;
    order: number;
    hasVideo: boolean;
    hasQuiz: boolean;
    videoUnlocksPrior: boolean;
    createdAt: string;
    updatedAt: string;
  };
  resource?: LessonResource;
  quizSkipEnabled: boolean;
  pdfDownloadEligibility: PdfDownloadEligibility;
  /** テスト任意化 Stage 5(ケースD厳格化): SessionRulesNotice の「有効セッション必須」注意書きの表示条件（flag ON かつ動画ありレッスンのみ） */
  sessionRequired: boolean;
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
