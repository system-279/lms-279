/**
 * Run-level lock の薄い service layer。
 *
 * 設計仕様書 §6.3、FR-11、AC-16 (Codex Important-3) 対応。
 *
 * 責務:
 *   - runId 生成 (uuid v4) + leaseExpiresAt / ttlExpireAt 算出
 *   - DispatchStorage.acquireRunLock に委譲
 *   - completed / aborted / timeout 遷移を caller から受領
 *
 * caller (Phase 4 internal endpoint) のフロー:
 *   1. acquireRunLockOrSkip(now=Date.now()) → { acquired: true, runId } または skip
 *   2. acquired=true なら ② tenant 走査 ... ⑫ audit log ⑬ completeRun
 *   3. acquired=false なら 409 で即時返却 (Cloud Scheduler 重複起動の正常系)
 */

import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import type {
  AcquireRunLockOutcome,
  DispatchStorage,
  UpdateRunStatusInput,
} from "./dispatch-storage.js";
import { DISPATCH_AUDIT_TTL_MS } from "./dispatch-storage.js";

export interface AcquireRunLockOrSkipInput {
  /** 現在時刻 (テスト時固定可、Date 注入) */
  now: Date;
  /** caller 生成の runId (uuid v4 等)。テスト時固定可 */
  runId: string;
}

/**
 * Run lock 取得試行。
 *
 * 既存 running run が lease 期限内なら拒否 (Cloud Scheduler 重複起動対策、AC-16)。
 * 取得成功時は status=running、processedTenants=sent=skipped=failed=0 で create。
 */
export async function acquireRunLockOrSkip(
  storage: DispatchStorage,
  input: AcquireRunLockOrSkipInput,
): Promise<AcquireRunLockOutcome> {
  const { now, runId } = input;
  const nowMs = now.getTime();
  const leaseExpiresAt = new Date(
    nowMs + DISPATCH_CONSTRAINTS.DISPATCH_RUN_LEASE_MS,
  ).toISOString();
  const ttlExpireAt = new Date(nowMs + DISPATCH_AUDIT_TTL_MS).toISOString();

  return storage.acquireRunLock({
    runId,
    triggeredAt: now.toISOString(),
    leaseExpiresAt,
    ttlExpireAt,
  });
}

/**
 * Run 完了/中断時の status 更新。caller は集計済メトリクスを渡す。
 *
 * abortedReason は sanitized 文字列 (PII を含まない、caller 責務)。
 */
export async function finalizeRun(
  storage: DispatchStorage,
  input: UpdateRunStatusInput,
): Promise<void> {
  return storage.updateRunStatus(input);
}

export interface RunMetricsForFinalize {
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  manualReviewRequired: number;
}

/** convenience: completed 用ヘルパー (status を明示せず metrics のみ渡す) */
export async function completeRun(
  storage: DispatchStorage,
  runId: string,
  metrics: RunMetricsForFinalize,
): Promise<void> {
  return finalizeRun(storage, {
    runId,
    status: "completed",
    ...metrics,
  });
}

/** convenience: aborted 用ヘルパー (403 scope_revoked 等の全体中断) */
export async function abortRun(
  storage: DispatchStorage,
  runId: string,
  abortedReason: string,
  metrics?: RunMetricsForFinalize,
): Promise<void> {
  return finalizeRun(storage, {
    runId,
    status: "aborted",
    abortedReason,
    ...metrics,
  });
}
