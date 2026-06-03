/**
 * Lane-level lock の薄い service layer (Phase 3、ADR-039 D-4)。
 *
 * 設計仕様書 §4.1 (主フロー: acquireLaneLock → run-progress-reports.ts)、
 * AC-PR-09 (lane lock transactional 排他) 対応。
 *
 * `run-lock.ts` (runId 単位の重複検査) と並列の別 service:
 *   - run-lock: super_dispatch_runs/{runId} 単位の duplicate runId 検査
 *   - lane-lock: super_dispatch_lane_locks/{laneId} 単位の同 lane 並行 request 排他
 *
 * Codex CRITICAL-3 反映: 完了通知レーンの query→set best-effort では同 lane 並行 request の
 * race を解消できないため、Phase 3 では別 doc + transactional 取得を採用する。
 * 完了通知レーンは互換維持のため lane lock 未導入、Phase 4 で統合検討。
 *
 * 責務:
 *   - now + PROGRESS_REPORT_LANE_LOCK_LEASE_MS で leaseExpiresAt を算出
 *   - DispatchStorage.acquireLaneLock / completeLaneLock / abortLaneLock に委譲
 *
 * caller (PR 3c run-progress-reports.ts) のフロー:
 *   1. acquireLaneLockOrSkip({laneId, ownerRunId, occurrenceId, now})
 *      → { acquired: true, lock } または { acquired: false, currentLock }
 *   2. acquired=true なら ② schedule check → tenant 走査 → finalize
 *      finalize で completeLaneLock(or abortLaneLock)
 *   3. acquired=false なら audit (lane_lock_contention) + no-op response 即返
 */

import { DISPATCH_CONSTRAINTS, type DispatchLane } from "@lms-279/shared-types";
import type {
  AcquireLaneLockOutcome,
  DispatchStorage,
} from "./dispatch-storage.js";

export interface AcquireLaneLockOrSkipInput {
  laneId: DispatchLane;
  /** 取得しようとしている run の ID */
  ownerRunId: string;
  /**
   * Cloud Scheduler 冪等性キー (進捗レポートレーンで必須、完了通知では省略)。
   * 本値自体は lane lock の重複判定には使われず、storage 層が doc に書き込んで
   * 監査用に保持するだけ (recipient 単位の冪等性は別 collection で担保)。
   */
  occurrenceId?: string;
  /** 現在時刻 (テスト時固定可) */
  now: Date;
}

/**
 * Lane lock 取得試行 (進捗レポートレーン用)。
 *
 * lease 期限内に他 run が同 lane の lock を保持していれば拒否、それ以外は新規取得。
 * lease 期限切れの旧 lock は新 run が上書き取得する (storage 層 transaction 内で判定)。
 */
export async function acquireLaneLockOrSkip(
  storage: DispatchStorage,
  input: AcquireLaneLockOrSkipInput,
): Promise<AcquireLaneLockOutcome> {
  const { laneId, ownerRunId, occurrenceId, now } = input;
  const nowMs = now.getTime();
  const leaseExpiresAt = new Date(
    nowMs + DISPATCH_CONSTRAINTS.PROGRESS_REPORT_LANE_LOCK_LEASE_MS,
  ).toISOString();

  return storage.acquireLaneLock({
    laneId,
    ownerRunId,
    ...(occurrenceId !== undefined && { occurrenceId }),
    now: now.toISOString(),
    leaseExpiresAt,
  });
}

/**
 * Lane lock の正常解放 (run 正常完了時)。
 * ownerRunId 不一致時は storage 層が no-op (古い run が新 lock を消さない)。
 */
export async function completeLaneLock(
  storage: DispatchStorage,
  laneId: DispatchLane,
  ownerRunId: string,
): Promise<void> {
  return storage.completeLaneLock({ laneId, ownerRunId });
}

/**
 * Lane lock の abort 経路での解放 (例: RunAbortError catch 後)。
 * ownerRunId 不一致時は storage 層が no-op (completeLaneLock と同じ契約)。
 * abortedReason は sanitized 文字列 (PII を含まない、caller 責務)。
 */
export async function abortLaneLock(
  storage: DispatchStorage,
  laneId: DispatchLane,
  ownerRunId: string,
  abortedReason: string,
): Promise<void> {
  return storage.abortLaneLock({ laneId, ownerRunId, abortedReason });
}
