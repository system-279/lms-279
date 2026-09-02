/**
 * Google Chat の受信 Webhook への投稿。
 *
 * Webhook URL は Secret Manager から取得する（コードにもログにも出力しない）。
 * 投稿は指定ユーザーとしてではなく、Webhook を作成した Chat アプリ（Bot）名で表示される。
 *
 * 失敗時の分類（運用通知自動化プラン参照）:
 *   - transient（ネットワーク例外・5xx）: 呼び出し元が nack/retry できるよう ok:false を返す
 *   - permanent（4xx。Webhook 失効等）: 同様に ok:false を返すが、呼び出し元は 200 ack して
 *     ループさせない設計にする（本モジュールはその判断に必要な status を返すのみ）
 *
 * notification 自身の障害検知（クロスレビュー High #4）:
 *   このモジュールの ERROR ログが、Cloud Monitoring のログベースメトリクスの監視対象になる
 *   （notification は Sink 対象から除外されているため、Chat への転送はできないが、
 *   別経路＝メール通知でこの ERROR を拾う設計。詳細は docs/runbook/monitoring-setup.md）。
 */

import { getSecretValue } from "./secret-manager.js";
import { logger } from "./logger.js";

// Google Chat の実務上の安全マージン（仕様上限は 4096 文字）
const CHAT_MESSAGE_MAX_LENGTH = 4000;

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

export async function postToChat(
  text: string,
  webhookSecretName: string,
  deps: ChatClientDeps = {}
): Promise<ChatPostResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getSecret = deps.getSecret ?? getSecretValue;

  let webhookUrl: string;
  try {
    webhookUrl = await getSecret(webhookSecretName);
  } catch (err) {
    logger.error("Chat webhook URL の取得に失敗しました", {
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
    });
    if (!res.ok) {
      logger.error("Chat webhook post failed", { status: res.status });
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    logger.error("Chat webhook post failed", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { ok: false };
  }
}
