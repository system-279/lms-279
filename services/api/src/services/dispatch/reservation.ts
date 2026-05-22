/**
 * Pre-send reservation の薄い service layer。
 *
 * 設計仕様書 §6.2、FR-7 改訂、AC-10/11/12、NFR-3 改訂 (Codex Critical-1+3) 対応。
 *
 * 責務:
 *   - `DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS` から leaseExpiresAt を算出して
 *     DispatchStorage.tryReserveCompletionNotification に委譲
 *   - markSent / markFailed は引数 passthrough (storage 実装に応じた atomicity を提供)
 *
 * caller (Phase 4 run-completion-notifications.ts) のフロー:
 *   1. tryReserveOrSkip(...) → ReservationOutcome
 *   2. reserved=true なら Gmail 送信、その後 markSent または markFailed
 *   3. reserved=false なら caller 側で audit log のみ書き skip
 *
 * 本 layer は storage 抽象を介すため Firestore / InMemory 両方で動作する。
 */

import {
  DISPATCH_CONSTRAINTS,
  type CompletionNotification,
  type ReservationOutcome,
} from "@lms-279/shared-types";
import type {
  DispatchStorage,
  MarkFailedPermanentInput,
  MarkSentInput,
} from "./dispatch-storage.js";

export interface TryReserveOrSkipInput {
  tenantId: string;
  userId: string;
  runId: string;
  /** 現在時刻 (テスト時固定可、Date 注入) */
  now: Date;
}

/**
 * Reservation 試行。成功時は storage 側で reserved レコードが create される。
 * 既存レコードがあれば status により skip 理由を返す。
 *
 * lease 期限切れの reserved は manual_review_required に降格された上で skip 扱い
 * (storage 側で同 transaction 内に降格 update が実施される)。
 */
export async function tryReserveOrSkip(
  storage: DispatchStorage,
  input: TryReserveOrSkipInput,
): Promise<ReservationOutcome> {
  const { tenantId, userId, runId, now } = input;
  const leaseExpiresAt = new Date(
    now.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS,
  ).toISOString();

  return storage.tryReserveCompletionNotification({
    tenantId,
    userId,
    runId,
    now: now.toISOString(),
    leaseExpiresAt,
  });
}

/**
 * 送信成功時の reserved → sent 遷移。caller は reservation 取得済 (reserved=true)
 * の前提で呼び出す。reservation なしで呼ぶと storage 側で throw する。
 */
export async function markSent(
  storage: DispatchStorage,
  input: MarkSentInput,
): Promise<void> {
  return storage.markCompletionNotificationSent(input);
}

/**
 * Permanent 失敗時の reserved → failed_permanent 遷移。
 *
 * 注意: caller は errorMessage を `sanitizeErrorForAudit()` 済の値で渡すこと
 * (PII 漏洩防止、NFR-11)。本 layer は再 sanitize しない (二重 redaction 回避)。
 */
export async function markFailedPermanent(
  storage: DispatchStorage,
  input: MarkFailedPermanentInput,
): Promise<void> {
  return storage.markCompletionNotificationFailedPermanent(input);
}

/**
 * Reservation レコード取得 (主に dry-run / audit / テスト用)。
 * 本フロー中の status 確認には reserve 戻り値を使うこと (read-modify-write race
 * 防止のため、storage 側 atomic op を経由する)。
 */
export async function getReservation(
  storage: DispatchStorage,
  tenantId: string,
  userId: string,
): Promise<CompletionNotification | null> {
  return storage.getCompletionNotification(tenantId, userId);
}
