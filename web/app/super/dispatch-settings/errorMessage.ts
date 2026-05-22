import { ApiError } from "@/lib/api";

/** ApiError / Error を日本語メッセージへ。401/403 は定型文 (既存 super ページと同方針)。 */
export function getDispatchErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 401) {
      return "認証の有効期限が切れました。再ログインしてください。";
    }
    if (e.status === 403) return "この操作を行う権限がありません。";
    return e.message || fallback;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}
