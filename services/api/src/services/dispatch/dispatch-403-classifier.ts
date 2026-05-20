/**
 * Gmail API 403 エラーを「全体中断」と「宛先固有」に分類する純粋関数。
 *
 * 設計仕様書 §6.4、Codex セカンドオピニオン Important-4 (403 reason 分類) に対応。
 *
 * 背景:
 *   全体設定ミス (DWD scope 未反映 / 管理者同意撤回 / 送信元 disabled) で 403 が返ると、
 *   それを user 固有の permanent 失敗として全 user を failed_permanent に終端化してしまう。
 *   これを防ぐため、reason 別に分類して全体中断 (run abort) と user permanent を分ける。
 *
 * 戻り値:
 *   - "scope_revoked": run 全体中断、後続 user の Reservation も rollback
 *   - "user_permanent": この user だけ failed_permanent、run は継続
 */

import type { Gmail403Classification } from "@lms-279/shared-types";

/**
 * Gmail API 403 で「全体設定ミス」を示す reason 一覧。
 *
 * Google Gmail API ドキュメントで定義されている代表的な reason:
 * - insufficientPermissions: DWD scope 未反映 / 認可不足
 * - delegationDenied: なりすまし送信が拒否された (subject 設定ミス等)
 * - userRateLimitExceeded: sender 単位の制限超過 (実質 sender disabled)
 * - forbidden: 一般的な認可エラー、DWD 未反映の典型
 *
 * これら以外 (recipientRejected 等) は宛先固有として user_permanent に分類する。
 */
const SCOPE_REVOKED_REASONS = new Set<string>([
  "insufficientPermissions",
  "delegationDenied",
  "userRateLimitExceeded",
  "forbidden",
]);

export function classifyGmail403(err: unknown): Gmail403Classification {
  if (!err || typeof err !== "object") {
    return "user_permanent";
  }
  const e = err as {
    response?: { data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  const reason = e.response?.data?.error?.errors?.[0]?.reason;
  if (typeof reason === "string" && SCOPE_REVOKED_REASONS.has(reason)) {
    return "scope_revoked";
  }
  return "user_permanent";
}
