/**
 * 進捗レポート recipient state machine の薄い service layer (Phase 3 PR 3c、ADR-039 D-3)。
 *
 * 設計仕様書 §4.1、AC-PR-06/07/08/17 対応。
 * reservation.ts と並列の別 service:
 *   - reservation: 完了通知レーン (userId 単位・永続)
 *   - progress-report-recipient: 進捗レポートレーン (occurrenceId × userId・90日 TTL)
 *
 * 責務:
 *   - `DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_LEASE_MS` と
 *     `PROGRESS_REPORT_RECIPIENT_TTL_DAYS` から leaseExpiresAt / ttlExpireAt を算出
 *   - DispatchStorage.tryClaimProgressRecipient に委譲 (transactional claim)
 *   - markSent / markFailed は引数 passthrough (precondition は storage 側で enforce)
 *
 * caller (PR 3c run-progress-reports.ts) のフロー:
 *   1. tryClaimRecipientOrSkip(...) → ProgressReportClaimOutcome
 *   2. claimed=true → PDF 生成 + Gmail 送信
 *   3. 送信成功 → markRecipientSent / 送信失敗 → markRecipientFailed
 *   4. claimed=false → audit log + skip (理由別 metrics 更新)
 *
 * AC-PR-07 (pending lease 切れ): storage 側 transaction 内で pending→manual_review に
 * 自動降格 + claim 失敗 → caller は降格 reason を受け取り skip + audit + metrics 更新。
 */

import {
  DISPATCH_CONSTRAINTS,
  type ProgressReportClaimOutcome,
  type ProgressReportRecipient,
} from "@lms-279/shared-types";
import type {
  DispatchStorage,
  GetProgressRecipientInput,
  MarkProgressRecipientFailedInput,
  MarkProgressRecipientSentInput,
} from "./dispatch-storage.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TryClaimRecipientOrSkipInput {
  tenantId: string;
  userId: string;
  /** Cloud Scheduler at-least-once 冪等性キー (sha256(laneId + ScheduleTime)) */
  occurrenceId: string;
  /** HTTP attempt 単位の監査用 UUID */
  runId: string;
  /** 現在時刻 (テスト時固定可、Date 注入) */
  now: Date;
}

/**
 * Recipient claim 試行 (AC-PR-06 / AC-PR-07 / AC-PR-08 / AC-PR-17)。
 *
 * 成功時は storage 側で `status=pending` レコードが create される。
 * 既存 doc あり: 状態に応じて skip 理由を返す。
 *   - already_sent: 同 occurrence で既送信 → 冪等 skip
 *   - already_failed: 既 permanent 失敗 → skip
 *   - currently_pending_by_other_worker: 他 worker 処理中 → skip
 *   - pending_lease_expired_promoted_to_manual_review: lease 切れ降格済 → skip
 *   - already_manual_review_required: 既 manual_review → skip
 *
 * AC-PR-17: ttlExpireAt は claim 時点で `claimedAt + 90 days` に設定 (Firestore TTL Policy
 * で自動削除)。
 */
export async function tryClaimRecipientOrSkip(
  storage: DispatchStorage,
  input: TryClaimRecipientOrSkipInput,
): Promise<ProgressReportClaimOutcome> {
  const { tenantId, userId, occurrenceId, runId, now } = input;
  const nowMs = now.getTime();
  const leaseExpiresAt = new Date(
    nowMs + DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_LEASE_MS,
  ).toISOString();
  const ttlExpireAt = new Date(
    nowMs + DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_TTL_DAYS * MS_PER_DAY,
  ).toISOString();

  return storage.tryClaimProgressRecipient({
    tenantId,
    userId,
    occurrenceId,
    runId,
    now: now.toISOString(),
    leaseExpiresAt,
    ttlExpireAt,
  });
}

/**
 * 送信成功時の pending → sent 遷移 + sent fields 更新。
 *
 * **三者一致 precondition (Codex HIGH-2 反映、storage 側で enforce)**:
 *   既存 doc が `status=pending` かつ `occurrenceId` / `runId` 一致のみ更新。
 *   不一致は storage 側で throw (lease 切れ降格後の stale finalize 防止)。
 *
 * caller は markRecipientSent 呼び出し前に tryClaimRecipientOrSkip で
 * `{claimed: true}` を取得済の前提。
 */
export async function markRecipientSent(
  storage: DispatchStorage,
  input: MarkProgressRecipientSentInput,
): Promise<void> {
  return storage.markProgressRecipientSent(input);
}

/**
 * Permanent 失敗時の pending → failed 遷移 + error fields 更新。
 * 三者一致 precondition は markRecipientSent と同じ (storage 側で enforce)。
 *
 * 注意: caller は errorMessage を `sanitizeErrorForAudit()` 済の値で渡すこと
 * (PII 漏洩防止、NFR-11)。本 layer は再 sanitize しない (二重 redaction 回避)。
 */
export async function markRecipientFailed(
  storage: DispatchStorage,
  input: MarkProgressRecipientFailedInput,
): Promise<void> {
  return storage.markProgressRecipientFailed(input);
}

/**
 * Recipient レコード取得 (主に dry-run / audit / テスト用)。
 * 本フロー中の status 確認には claim 戻り値を使うこと (read-modify-write race
 * 防止のため、storage 側 atomic op を経由する)。
 */
export async function getRecipient(
  storage: DispatchStorage,
  input: GetProgressRecipientInput,
): Promise<ProgressReportRecipient | null> {
  return storage.getProgressRecipient(input);
}
