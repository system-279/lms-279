/**
 * Issue #425: Firestore (および Firebase Admin SDK) の transient エラーに対する
 * 共通リトライユーティリティ。
 *
 * 設計方針:
 * - transient/permanent の分類は `grpc-errors.ts:classifyFirestoreError` を再利用 (DRY)
 * - exponential backoff (base * 2^attempt) で待機 (jitter なし、PR scope 内では単純化)
 * - permanent エラーは即座に throw (retry しない)
 * - rules/error-handling.md §3 「transient/permanent 分類」原則と整合
 *
 * 適用範囲:
 * - lesson-session.ts cleanupInProgressAttempts (PR #423 follow-up)
 * - その他 Firestore 呼び出しへの適用は段階的に別 PR で
 */

import { classifyFirestoreError } from "./grpc-errors.js";
import { logger } from "./logger.js";

export interface WithTransientRetryOptions {
  /** 最大試行回数 (初回 + リトライ)。default 3。1 以上の整数。 */
  maxAttempts?: number;
  /** 初回 retry 待機時間 (ms)。default 100。指数的に baseDelayMs * 2^attempt で増加。0 以上。 */
  baseDelayMs?: number;
  /**
   * logger.warn に出す追加コンテキスト (tenantId / userId / operation 名等)。
   * 既存の `cleanupInProgressAttempts` 等の Cloud Logging 方針に合わせ、必要最小限の識別子のみ渡す
   * (raw email / 個人氏名等の PII は含めない)。
   */
  context?: Record<string, unknown>;
}

/**
 * fn を実行し、transient エラーで失敗した場合に exponential backoff でリトライする。
 *
 * - 成功: そのまま値を返す
 * - permanent エラー: 即座に throw (retry しない)
 * - transient エラー: 最大 (maxAttempts - 1) 回 retry し、それでも失敗なら最後のエラーを throw
 * - retry 毎に logger.warn で記録 (errorType=transient_retry)
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: WithTransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 100;

  // Codex review (Low 74) 対応: 共通 util として広く使われる前提で入力検証。
  // 不正値で「fn が一度も呼ばれず undefined を throw」のサイレント失敗を防ぐ。
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(
      `withTransientRetry: maxAttempts must be a positive integer (got ${maxAttempts})`,
    );
  }
  if (typeof baseDelayMs !== "number" || baseDelayMs < 0 || !Number.isFinite(baseDelayMs)) {
    throw new TypeError(
      `withTransientRetry: baseDelayMs must be a non-negative finite number (got ${baseDelayMs})`,
    );
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const { grpcCode, isTransient } = classifyFirestoreError(err);
      // permanent エラー or 最終試行 → 即 throw (retry しない)
      if (!isTransient || attempt === maxAttempts - 1) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      // Codex review (Medium 78) 対応: rules/error-handling.md §1「状態復旧 > ログ記録」原則に従い、
      // logger.warn が throw (例: 循環参照付き context で JSON.stringify 失敗) しても retry 自体は継続する。
      try {
        logger.warn("withTransientRetry: retrying", {
          errorType: "transient_retry",
          attempt: attempt + 1,
          maxAttempts,
          delay,
          grpcCode,
          ...opts.context,
        });
      } catch (loggerErr) {
        // logger 失敗時は console.error にだけ落とし、retry は止めない
        console.error("withTransientRetry: logger.warn failed (continuing retry):", loggerErr);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // unreachable (loop は throw か return で必ず抜ける) だが TypeScript 用に明示
  throw lastError;
}
