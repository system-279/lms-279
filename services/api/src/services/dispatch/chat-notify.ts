/**
 * 配信結果 (完了通知/進捗レポート) の Google Chat 通知 (PR3、配信可視化)。
 *
 * `services/notification/src/chat-client.ts` / `secret-manager.ts` /
 * `chat-payload-allowlist.ts` (ADR-042) の複製。このリポジトリには
 * 「小さい自己完結ファイルは共有パッケージ化せず複製する」という明文の既存方針が
 * あり (`services/notification/src/logger.ts` 冒頭コメント参照)、本ファイルもそれに倣う。
 *
 * ADR-042 の配置決定 (新規コードは `services/notification` に置く) はこの用途には
 * 適用されない — 詳細は ADR-042 追記 (PR3) を参照。配信結果レポートは
 * 「API が正常に動いて送信を完了した」ことを前提とする成果報告であり、
 * ADR-042 が想定する「API 障害を報告する」通知とは障害ドメインの前提が異なる。
 *
 * PII 対策 (ADR-042 と同じ二層防御):
 *   - 型で転送フィールドを固定 (allowlist、DispatchNotifyInput)
 *   - 許可フィールドの中身 (テナント名) にも maskPii を通す (自由記述文字列のため)
 */

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { logger } from "../../utils/logger.js";
import type { DispatchLane } from "@lms-279/shared-types";

// ============================================================
// Secret Manager (services/notification/src/secret-manager.ts の複製)
// ============================================================

let secretManagerClient: SecretManagerServiceClient | null = null;

async function getSecretValue(secretName: string): Promise<string> {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const [version] = await secretManagerClient.accessSecretVersion({
    name: secretName,
  });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`Secret payload is empty (${secretName})`);
  }
  return typeof payload === "string" ? payload : payload.toString();
}

// ============================================================
// PII マスク (services/notification/src/chat-payload-allowlist.ts の複製)
// ============================================================

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGIT_RE = /\d[\d\-\s]{7,}\d/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local[0] ?? "*";
  return `${visible}***@${domain}`;
}

/** メールアドレス・Bearerトークン・長い数字列(電話番号等)をマスクする */
export function maskPii(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(BEARER_RE, "Bearer ***")
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(LONG_DIGIT_RE, (m) => `${m.slice(0, 2)}***${m.slice(-2)}`);
}

// ============================================================
// Chat 投稿 (services/notification/src/chat-client.ts の複製)
// ============================================================

const CHAT_MESSAGE_MAX_LENGTH = 4000;
const CHAT_FETCH_TIMEOUT_MS = 10_000;

export interface ChatPostResult {
  ok: boolean;
  status?: number;
}

export interface ChatClientDeps {
  fetchImpl?: typeof fetch;
  getSecret?: (secretName: string) => Promise<string>;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n...(truncated)`;
}

/**
 * Google Chat の受信 Webhook へ投稿する。**一切 throw しない** (Secret 取得失敗・
 * 非2xx・fetch 例外いずれも `{ok:false}` を返す、`chat-client.ts` と同じ契約)。
 */
export async function postToChat(
  text: string,
  webhookSecretName: string,
  deps: ChatClientDeps = {},
): Promise<ChatPostResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getSecret = deps.getSecret ?? getSecretValue;

  let webhookUrl: string;
  try {
    webhookUrl = await getSecret(webhookSecretName);
  } catch (err) {
    logger.error("dispatch chat webhook URL の取得に失敗しました", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { ok: false };
  }

  const truncated = truncate(text, CHAT_MESSAGE_MAX_LENGTH);

  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text: truncated }),
      signal: AbortSignal.timeout(CHAT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error("dispatch chat webhook post failed", { status: res.status });
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    logger.error("dispatch chat webhook post failed", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { ok: false };
  }
}

// ============================================================
// 配信結果レポートのメッセージ組み立て + notifier DI (PR3 本体)
// ============================================================

const LANE_LABEL: Record<DispatchLane, string> = {
  completion: "完了通知",
  progress: "進捗レポート",
};

/** テナント単位の集計 (件数のみ。氏名・メールアドレスは含めない) */
export interface TenantMetricsEntry {
  tenantId: string;
  tenantName: string;
  sent: number;
  failed: number;
  manualReviewRequired: number;
}

export type DispatchNotifyOutcome = "completed" | "aborted" | "unexpected_error";

/**
 * Chat へ転送してよいフィールドを型で固定する (allowlist、ADR-042 方針)。
 * 受講者 ID・メールアドレス・任意の追加 metadata は転送経路自体に乗らない。
 */
export interface DispatchNotifyInput {
  outcome: DispatchNotifyOutcome;
  lane: DispatchLane;
  runId: string;
  /** progress レーンのみ設定 */
  occurrenceId?: string;
  totalSent: number;
  totalFailed: number;
  totalManualReviewRequired: number;
  /** 件数 > 0 のテナントのみを含める想定 (呼び出し元でフィルタ) */
  perTenant: TenantMetricsEntry[];
  /** outcome !== "completed" のときのみ意味を持つ (sanitize 済の前提、dispatch-error-sanitizer.ts 参照) */
  abortedReason?: string;
}

export type DispatchNotifier = (
  input: DispatchNotifyInput,
) => Promise<{ ok: boolean }>;

function outcomeHeader(outcome: DispatchNotifyOutcome): string {
  if (outcome === "completed") return "";
  if (outcome === "aborted") return "【中断】";
  return "【異常終了】";
}

/** 配信結果レポートの Chat メッセージ本文を組み立てる (テナント名は maskPii を通す) */
export function buildDeliveryReportText(input: DispatchNotifyInput): string {
  const lines: string[] = [];
  const header = outcomeHeader(input.outcome);
  const laneLabel = LANE_LABEL[input.lane];
  lines.push(`${header}【${laneLabel}】配信結果 (runId=${input.runId}${input.occurrenceId ? `, occurrenceId=${input.occurrenceId}` : ""})`);

  if (input.outcome !== "completed" && input.abortedReason) {
    lines.push(`中断理由: ${maskPii(input.abortedReason)}`);
  }

  lines.push(
    `合計: ${input.totalSent} 件成功 / ${input.totalFailed} 件失敗 / ${input.totalManualReviewRequired} 件要確認`,
  );

  for (const t of input.perTenant) {
    lines.push(
      `- ${maskPii(t.tenantName)}: ${t.sent} 件成功 / ${t.failed} 件失敗 / ${t.manualReviewRequired} 件要確認`,
    );
  }

  return lines.join("\n");
}

/**
 * production notifier: 指定された Secret Manager リソース名の webhook へ配信結果を投稿する。
 * `postToChat` と同じ契約で throw しない。
 *
 * `deps` は `postToChat` への透過的な注入口 (test で `fetchImpl`/`getSecret` を差し替え、
 * 実 Secret Manager / 実 fetch への疎通なしに notifier の動作を検証できるようにする。
 * fable-review L5 反映)。
 */
export function createChatNotifier(
  webhookSecretName: string,
  deps: ChatClientDeps = {},
): DispatchNotifier {
  return async (input) => {
    const text = buildDeliveryReportText(input);
    const result = await postToChat(text, webhookSecretName, deps);
    return { ok: result.ok };
  };
}

/**
 * 呼び出し元 (`run-completion-notifications.ts` / `run-progress-reports.ts`) から
 * 成功・abort・想定外エラーの3経路すべてで呼ぶ共通ヘルパー (pr-review-toolkit
 * code-reviewer 指摘反映: 完了通知/進捗レポート両レーンにほぼ同一ロジックが
 * コピーされ、将来の仕様変更でレーン間の分岐リスクがあったため一本化)。
 *
 * - 0件スキップ (`outcome==="completed" && 全カウント0`) は成功時のみ適用する。
 *   中断・例外時は部分送信が0件でも通知する (中断そのものが異常事態のため)。
 * - notifier が reject しても run を落とさない (呼び出し元は必ず try-catch で包むこと、
 *   本関数自身もここで catch する防御的二重化)。
 * - notifier が `{ok:false}` を返した場合も、runId/lane/occurrenceId/outcome を
 *   含めて warn ログを残す (pr-review-toolkit silent-failure-hunter 指摘反映:
 *   従来は戻り値が握りつぶされ、失敗しても相関情報付きのログが一切残らなかった)。
 */
export interface NotifyDispatchResultInput {
  notifier: DispatchNotifier | undefined;
  outcome: DispatchNotifyOutcome;
  lane: DispatchLane;
  runId: string;
  /** progress レーンのみ設定 */
  occurrenceId?: string;
  totalSent: number;
  totalFailed: number;
  totalManualReviewRequired: number;
  /** 件数 > 0 のテナントのみに絞り込むのは呼び出し元の責務ではなく本関数が行う */
  perTenant: readonly TenantMetricsEntry[];
  /** outcome !== "completed" のときのみ意味を持つ (sanitize 済の前提) */
  abortedReason?: string;
}

export async function notifyDispatchResult(
  input: NotifyDispatchResultInput,
): Promise<void> {
  const {
    notifier,
    outcome,
    lane,
    runId,
    occurrenceId,
    totalSent,
    totalFailed,
    totalManualReviewRequired,
    perTenant,
    abortedReason,
  } = input;
  if (!notifier) return;
  if (
    outcome === "completed" &&
    totalSent === 0 &&
    totalFailed === 0 &&
    totalManualReviewRequired === 0
  ) {
    return;
  }
  try {
    const result = await notifier({
      outcome,
      lane,
      runId,
      occurrenceId,
      totalSent,
      totalFailed,
      totalManualReviewRequired,
      perTenant: perTenant.filter(
        (t) => t.sent > 0 || t.failed > 0 || t.manualReviewRequired > 0,
      ),
      abortedReason,
    });
    if (!result.ok) {
      logger.warn("dispatch chat notify returned failure", {
        runId,
        lane,
        outcome,
        occurrenceId,
      });
    }
  } catch (err) {
    logger.error("dispatch chat notify failed", {
      runId,
      lane,
      outcome,
      occurrenceId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
