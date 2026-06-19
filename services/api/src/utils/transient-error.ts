/**
 * 外部 API 呼び出しで transient (一時的) か permanent (恒久的) かを判定する共通 util。
 *
 * 用途:
 *  - GCS / IAM Credentials / その他 Google API 呼び出しでネットワーク不安定や
 *    TCP 切断 (`Premature close`) を transient として扱い、自動リトライ可否を判定する。
 *
 * gmail-draft.ts / gmail-dwd-send.ts にも類似定義が存在するが、Phase 7 既存
 * 配送経路への影響を避けるため本 util は lesson-resource.ts 用途に絞って導入。
 * 後続 PR で gmail 系を統合予定 (Codex 指摘の共通 util 化方針)。
 */

/**
 * Node.js / undici / gaxios の transport-level error code。
 * これらは一時的なネットワーク不安定で発生し、リトライで回復しうる。
 */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * transient とみなすメッセージパターン。
 * `Premature close` は IAM Credentials API signBlob 等で観測 (本番障害 2026-06-19)。
 * `socket hang up` は Node.js HTTP の TCP 早期切断時に出る。
 */
const TRANSIENT_MESSAGE_PATTERN =
  /timeout|premature close|socket hang up|read econnreset|aborted|network socket disconnected/i;

/**
 * HTTP status 系 transient コード (リトライ可能)。
 */
const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 例外を transient (= リトライ価値あり) と判定する。
 *
 * 評価順 (上位ほど優先):
 *   1. `response.status` / `status` / `code` (number) が transient HTTP status
 *   2. `code` / `cause.code` (string) が transport-level transient code
 *   3. `message` が transient な文字列パターンにマッチ
 *
 * いずれにも当たらなければ permanent (false)。
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: { status?: unknown };
    cause?: { code?: unknown; message?: unknown };
  };

  const httpStatus =
    (typeof e.response?.status === "number" ? e.response.status : undefined) ??
    (typeof e.status === "number" ? e.status : undefined) ??
    (typeof e.code === "number" ? e.code : undefined);
  if (typeof httpStatus === "number" && TRANSIENT_HTTP_STATUS.has(httpStatus)) {
    return true;
  }

  const code = typeof e.code === "string" ? e.code : null;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;

  const causeCode = typeof e.cause?.code === "string" ? e.cause.code : null;
  if (causeCode && TRANSIENT_NETWORK_CODES.has(causeCode)) return true;

  const message = typeof e.message === "string" ? e.message : "";
  const causeMessage = typeof e.cause?.message === "string" ? e.cause.message : "";
  if (TRANSIENT_MESSAGE_PATTERN.test(message) || TRANSIENT_MESSAGE_PATTERN.test(causeMessage)) {
    return true;
  }

  return false;
}

/**
 * transient な op を有限回リトライする。permanent エラーは即時 throw。
 *
 * - delay は exponential backoff (factor 2) + ±20% jitter
 * - 副作用なし / idempotent な op を想定 (GCS signed URL 生成、メタデータ取得 等)
 * - リトライ回数を使い切ったら最後の例外を throw
 *
 * @param op リトライ対象の async 関数
 * @param opts.maxAttempts 試行回数 (デフォルト 2、つまり初回 + 1 リトライ)
 * @param opts.baseDelayMs 初回 backoff 基準 (デフォルト 150ms)
 * @param opts.onRetry 各リトライ前に呼ばれる observer (ログ等)
 */
export async function retryOnTransient<T>(
  op: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 150;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts || !isTransientError(e)) throw e;
      const factor = 2 ** (attempt - 1);
      const jitter = 0.8 + Math.random() * 0.4;
      const delayMs = Math.round(baseDelayMs * factor * jitter);
      // onRetry が throw してもリトライ自体は止めない (logger 破損耐性、
      // rules/error-handling.md §1 と整合 — pr-test-analyzer M2)
      try {
        opts.onRetry?.({ attempt, error: e, delayMs });
      } catch {
        // observer 失敗はリトライ継続より優先しない
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
