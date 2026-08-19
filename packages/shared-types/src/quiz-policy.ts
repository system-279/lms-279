/**
 * テスト任意化（テナント単位スキップ設定）の API DTO。
 * quizSkipEnabled=false（未設定テナント含む）が既定。
 * updatedBy/updatedAt は未設定テナントで null（一度も保存されていないことを表す）。
 */
export interface TenantQuizPolicyResponse {
  quizSkipEnabled: boolean;
  pdfDownloadAllowedForSkipped: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface PutTenantQuizPolicyRequest {
  quizSkipEnabled: boolean;
  pdfDownloadAllowedForSkipped: boolean;
}
