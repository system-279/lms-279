/**
 * Gmail API 403 エラーを「全体中断」と「宛先固有」に分類する純粋関数。
 *
 * 設計仕様書 §6.4、Codex セカンドオピニオン Important-4 (403 reason 分類) に対応。
 * PR #442 review で指摘された Critical 1 (forbidden 独断追加除去) / Critical 4 (errors.some) /
 * Critical 5 (HTTP 403 ガード) を反映済み。
 *
 * 背景:
 *   全体設定ミス (DWD scope 未反映 / 管理者同意撤回 / 送信元 disabled) で 403 が返ると、
 *   それを user 固有の permanent 失敗として全 user を failed_permanent に終端化してしまう。
 *   これを防ぐため、reason 別に分類して全体中断 (run abort) と user permanent を分ける。
 *
 * 入力前提:
 *   - 本関数は HTTP 403 専用。403 以外で呼ぶと呼び出し側のバグなので例外を throw する。
 *   - 呼び出し側で予め status を確認し、429/503 等の transient と 401 (token 失効) は
 *     別の分岐に流すこと。
 *
 * 戻り値:
 *   - "scope_revoked": run 全体中断、後続 user の Reservation も rollback
 *   - "user_permanent": この user だけ failed_permanent、run は継続
 */

import type { Gmail403Classification } from "@lms-279/shared-types";

/**
 * Gmail API 403 で「全体設定ミス」を示す reason 一覧。
 *
 * 設計仕様書 §6.4 に明示された 3 つの reason のみを採用する。
 * 仕様書未記載の reason を実装段階で独断追加することは AI 駆動開発 4 原則 §1
 * (decision-maker 領分越え) に該当するため、追加要望は spec 改訂 → 本田様承認 →
 * 本ファイル更新の順で行う。
 *
 * Google Gmail API ドキュメントで定義されている代表的な reason:
 * - insufficientPermissions: DWD scope 未反映 / 認可不足
 * - delegationDenied: なりすまし送信が拒否された (subject 設定ミス等)
 * - userRateLimitExceeded: sender 単位の制限超過 (実質 sender disabled)
 *
 * これら以外 (recipientRejected / forbidden / その他) は宛先固有として
 * user_permanent に分類する。
 */
const SCOPE_REVOKED_REASONS = new Set<string>([
  "insufficientPermissions",
  "delegationDenied",
  "userRateLimitExceeded",
]);

/**
 * Gmail API 403 を分類する。HTTP 403 以外で呼ぶと例外を throw する。
 *
 * Codex Critical-4: errors 配列を全件走査し、いずれかが SCOPE_REVOKED_REASONS にマッチすれば
 *   scope_revoked を返す (1 番目だけ見ない、全体設定ミスの取りこぼし防止)。
 * Codex Critical-5: 関数冒頭で response.status===403 をガードし、それ以外は throw。
 *   呼び出し側で 429/503/401 を別経路に流す責務を明確化する。
 */
export function classifyGmail403(err: unknown): Gmail403Classification {
  if (!err || typeof err !== "object") {
    throw new Error("classifyGmail403 received a non-object error");
  }
  const e = err as {
    response?: {
      status?: number;
      data?: { error?: { errors?: Array<{ reason?: unknown }> } };
    };
  };
  const status = e.response?.status;
  if (status !== 403) {
    throw new Error(
      `classifyGmail403 called for non-403 error (status=${status ?? "unknown"})`,
    );
  }
  const errors = e.response?.data?.error?.errors ?? [];
  const hasScopeRevoked = errors.some(
    (entry) =>
      typeof entry.reason === "string" && SCOPE_REVOKED_REASONS.has(entry.reason),
  );
  return hasScopeRevoked ? "scope_revoked" : "user_permanent";
}
