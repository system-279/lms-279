/**
 * 共通APIレスポンス型
 */

export interface ApiErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
