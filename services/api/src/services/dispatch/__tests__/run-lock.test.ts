/**
 * run-lock の Integration テスト。
 *
 * 設計仕様書 §6.3、FR-11、AC-16、Phase 2 完了条件:
 *   - run lock 同時起動 2 件で 1 つだけ成功するシナリオ確認
 *
 * 観点:
 *   - 単独 acquireRunLock → acquired=true、status=running、メトリクス 0 で create
 *   - 同時 acquireRunLock 2 件 → 1 件 acquired=true、もう 1 件 acquired=false (another_run_active)
 *   - duplicate runId → acquired=false (duplicate_run_id)
 *   - lease 期限切れ後の新規 acquire → 取得成功 (現在の lease 内に running が無いため)
 *   - completeRun / abortRun の status 遷移
 *   - メトリクス update (processedTenants/sent/skipped/failed)
 *   - abortedReason は sanitized 文字列のみを保存
 *   - leaseExpiresAt = now + DISPATCH_RUN_LEASE_MS (280s)
 *   - ttlExpireAt = now + AUDIT_LOGS_TTL_DAYS (365 days)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";
import {
  acquireRunLockOrSkip,
  finalizeRun,
  completeRun,
  abortRun,
} from "../run-lock.js";

const NOW = new Date("2026-05-22T01:00:00.000Z");

let storage: InMemoryDispatchStorage;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
});

describe("acquireRunLockOrSkip - 単独起動", () => {
  it("running run なし → acquired=true, status=running, メトリクス 0", async () => {
    const result = await acquireRunLockOrSkip(storage, {
      now: NOW,
      runId: "run-uuid-1",
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.run.runId).toBe("run-uuid-1");
      expect(result.run.status).toBe("running");
      expect(result.run.processedTenants).toBe(0);
      expect(result.run.sent).toBe(0);
      expect(result.run.skipped).toBe(0);
      expect(result.run.failed).toBe(0);
      expect(result.run.abortedReason).toBeNull();
      expect(result.run.triggeredAt).toBe(NOW.toISOString());
    }
  });

  it("leaseExpiresAt = now + DISPATCH_RUN_LEASE_MS (280s)", async () => {
    const result = await acquireRunLockOrSkip(storage, {
      now: NOW,
      runId: "run-uuid-2",
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      const expected = new Date(
        NOW.getTime() + DISPATCH_CONSTRAINTS.DISPATCH_RUN_LEASE_MS,
      ).toISOString();
      expect(result.run.leaseExpiresAt).toBe(expected);
    }
  });

  it("ttlExpireAt = now + AUDIT_LOGS_TTL_DAYS (365 days)", async () => {
    const result = await acquireRunLockOrSkip(storage, {
      now: NOW,
      runId: "run-uuid-3",
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      const expectedMs =
        NOW.getTime() +
        DISPATCH_CONSTRAINTS.AUDIT_LOGS_TTL_DAYS * 24 * 60 * 60 * 1000;
      expect(result.run.ttlExpireAt).toBe(new Date(expectedMs).toISOString());
    }
  });
});

describe("acquireRunLockOrSkip - 重複起動 (AC-16)", () => {
  it("同時 2 件で 1 件のみ acquired=true、もう 1 件 acquired=false (another_run_active)", async () => {
    // 2 つの request を同時に発行 (Promise.all で並列)
    const [a, b] = await Promise.all([
      acquireRunLockOrSkip(storage, { now: NOW, runId: "run-a" }),
      acquireRunLockOrSkip(storage, { now: NOW, runId: "run-b" }),
    ]);
    const acquiredCount = [a.acquired, b.acquired].filter(Boolean).length;
    expect(acquiredCount).toBe(1);

    const failed = a.acquired ? b : a;
    expect(failed.acquired).toBe(false);
    if (!failed.acquired) {
      expect(failed.reason).toBe("another_run_active");
    }
  });

  it("逐次の重複起動でも同様 (run 1 取得後の run 2 試行)", async () => {
    const first = await acquireRunLockOrSkip(storage, {
      now: NOW,
      runId: "run-1",
    });
    expect(first.acquired).toBe(true);

    const second = await acquireRunLockOrSkip(storage, {
      now: new Date(NOW.getTime() + 1000), // 1 秒後
      runId: "run-2",
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("another_run_active");
    }
  });

  it("duplicate runId (同 runId 2 回目) → acquired=false, reason=duplicate_run_id", async () => {
    await acquireRunLockOrSkip(storage, { now: NOW, runId: "run-dup" });
    const second = await acquireRunLockOrSkip(storage, {
      now: new Date(NOW.getTime() + 1000),
      runId: "run-dup", // 同 ID 再試行
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("duplicate_run_id");
    }
  });
});

describe("acquireRunLockOrSkip - lease 期限切れ後の再取得", () => {
  it("既存 run の lease が期限切れになったら新規 acquire 成功", async () => {
    const first = await acquireRunLockOrSkip(storage, {
      now: NOW,
      runId: "run-1",
    });
    expect(first.acquired).toBe(true);

    // lease 期限を超過した時点で別 run を試行
    const afterLease = new Date(
      NOW.getTime() + DISPATCH_CONSTRAINTS.DISPATCH_RUN_LEASE_MS + 1000,
    );
    const second = await acquireRunLockOrSkip(storage, {
      now: afterLease,
      runId: "run-2",
    });
    expect(second.acquired).toBe(true);
    // run-1 はそのまま保持 (lease 切れだが status は running のまま、別途 caller が timeout 更新する想定)
    const r1 = await storage.getRun("run-1");
    expect(r1?.status).toBe("running");
  });

  it("completed 状態の run は lease 期限内でも他 run の acquire を妨げない", async () => {
    const first = await acquireRunLockOrSkip(storage, {
      now: NOW,
      runId: "run-1",
    });
    expect(first.acquired).toBe(true);
    await completeRun(storage, "run-1", {
      processedTenants: 2,
      sent: 5,
      skipped: 0,
      failed: 0,
      manualReviewRequired: 0,
    });

    // lease 内だが completed なので新規 acquire OK
    const second = await acquireRunLockOrSkip(storage, {
      now: new Date(NOW.getTime() + 10_000),
      runId: "run-2",
    });
    expect(second.acquired).toBe(true);
  });
});

describe("finalizeRun / completeRun / abortRun", () => {
  it("completeRun: status=completed + メトリクス積算", async () => {
    await acquireRunLockOrSkip(storage, { now: NOW, runId: "run-x" });
    await completeRun(storage, "run-x", {
      processedTenants: 3,
      sent: 7,
      skipped: 2,
      failed: 1,
      manualReviewRequired: 0,
    });

    const run = await storage.getRun("run-x");
    expect(run?.status).toBe("completed");
    expect(run?.processedTenants).toBe(3);
    expect(run?.sent).toBe(7);
    expect(run?.skipped).toBe(2);
    expect(run?.failed).toBe(1);
    expect(run?.manualReviewRequired).toBe(0);
    expect(run?.abortedReason).toBeNull();
  });

  it("abortRun: status=aborted + abortedReason がセットされる (sanitized 前提)", async () => {
    await acquireRunLockOrSkip(storage, { now: NOW, runId: "run-y" });
    await abortRun(
      storage,
      "run-y",
      "gmail_scope_revoked",
      { processedTenants: 1, sent: 0, skipped: 0, failed: 0, manualReviewRequired: 2 },
    );

    const run = await storage.getRun("run-y");
    expect(run?.status).toBe("aborted");
    expect(run?.abortedReason).toBe("gmail_scope_revoked");
  });

  it("abortRun は metrics 省略可 (既存値が保持される)", async () => {
    await acquireRunLockOrSkip(storage, { now: NOW, runId: "run-z" });
    await abortRun(storage, "run-z", "early_abort");

    const run = await storage.getRun("run-z");
    expect(run?.status).toBe("aborted");
    expect(run?.abortedReason).toBe("early_abort");
    // メトリクスは初期値 0 のまま
    expect(run?.sent).toBe(0);
  });

  it("finalizeRun: 任意 status (timeout) も指定可", async () => {
    await acquireRunLockOrSkip(storage, { now: NOW, runId: "run-t" });
    await finalizeRun(storage, {
      runId: "run-t",
      status: "timeout",
      processedTenants: 1,
      sent: 0,
      skipped: 0,
      failed: 5,
    });

    const run = await storage.getRun("run-t");
    expect(run?.status).toBe("timeout");
    expect(run?.failed).toBe(5);
  });

  it("存在しない runId への finalizeRun は throw", async () => {
    await expect(
      finalizeRun(storage, { runId: "missing", status: "completed" }),
    ).rejects.toThrow(/no run found/);
  });
});
