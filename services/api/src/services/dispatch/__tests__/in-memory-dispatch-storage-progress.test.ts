/**
 * InMemoryDispatchStorage の Phase 3 進捗レポートレーン関連メソッドテスト。
 *
 * 関連 ADR: ADR-039 (D-2 occurrenceId / D-3 recipient state machine / D-4 lane lock)
 *
 * カバー AC:
 *   - AC-PR-06: occurrenceId 冪等 (claim 重複 reject)
 *   - AC-PR-07: pending lease 切れ → manual_review_required 降格
 *   - AC-PR-08: 別 occurrenceId で再 claim 成功
 *   - AC-PR-09: lane lock transactional 排他
 *   - AC-PR-17: TTL claim 時設定 (ttlExpireAt = claim 時点で必ず set)
 *
 * Codex Plan stage thread 019e8a8d 反映:
 *   - HIGH-2: markProgressRecipientSent/Failed の三者一致 precondition (status + occurrenceId + runId)
 *   - MEDIUM: lane lock complete/abort の ownerRunId 不一致 no-op (古い run が新 lock を消さない)
 *
 * AC-PR-18 (settings patch semantics) は in-memory-dispatch-storage.test.ts に追加。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";

const TENANT_A = "tenant-A";
const USER_X = "user-x";
const OCCURRENCE_1 = "occ-2026-06-03-09";
const OCCURRENCE_2 = "occ-2026-06-10-09";
const RUN_1 = "run-uuid-1";
const RUN_2 = "run-uuid-2";

const NOW = "2026-06-03T00:00:00.000Z";
const LEASE_10MIN = "2026-06-03T00:10:00.000Z";
const TTL_90D = "2026-09-01T00:00:00.000Z";

describe("InMemoryDispatchStorage.tryClaimProgressRecipient", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("初回 claim 成功 (status=pending、ttlExpireAt が claim 時点で設定される、AC-PR-17)", async () => {
    const outcome = await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    expect(outcome).toEqual({ claimed: true });

    const recipient = await storage.getProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
    });
    expect(recipient).not.toBeNull();
    expect(recipient!.status).toBe("pending");
    expect(recipient!.runId).toBe(RUN_1);
    expect(recipient!.occurrenceId).toBe(OCCURRENCE_1);
    expect(recipient!.claimedAt).toBe(NOW);
    expect(recipient!.leaseExpiresAt).toBe(LEASE_10MIN);
    expect(recipient!.ttlExpireAt).toBe(TTL_90D); // AC-PR-17 検証
    expect(recipient!.sentAt).toBeNull();
    expect(recipient!.messageId).toBeNull();
    expect(recipient!.recipientToHash).toBe(""); // claim 時点では未確定
    expect(recipient!.recipientCcHashes).toEqual([]);
  });

  it("同 occurrenceId + 同 user の 2 度目 claim は currently_pending_by_other_worker (AC-PR-06)", async () => {
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    const dup = await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_2, // 別 run でも reject
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    expect(dup).toEqual({
      claimed: false,
      reason: "currently_pending_by_other_worker",
    });
  });

  it("sent 済 recipient の再 claim は already_sent (AC-PR-06 冪等性)", async () => {
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    await storage.markProgressRecipientSent({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      sentAt: "2026-06-03T00:05:00.000Z",
      messageId: "msg-001",
      pdfSizeBytes: 1024,
      recipientToHash: "abc",
      recipientCcHashes: [],
    });
    const retry = await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_2,
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
      ttlExpireAt: TTL_90D,
    });
    expect(retry).toEqual({ claimed: false, reason: "already_sent" });
  });

  it("pending lease 切れ → manual_review_required 降格 (AC-PR-07)", async () => {
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    // 11 分後 (lease 切れ)
    const retry = await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_2,
      now: "2026-06-03T00:11:00.000Z",
      leaseExpiresAt: "2026-06-03T00:21:00.000Z",
      ttlExpireAt: TTL_90D,
    });
    expect(retry).toEqual({
      claimed: false,
      reason: "pending_lease_expired_promoted_to_manual_review",
    });
    // 降格後 state 確認
    const recipient = await storage.getProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
    });
    expect(recipient!.status).toBe("manual_review_required");
    expect(recipient!.promotedAt).toBe("2026-06-03T00:11:00.000Z");
  });

  it("別 occurrenceId で同 user を再 claim できる (AC-PR-08 翌週)", async () => {
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    await storage.markProgressRecipientSent({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      sentAt: "2026-06-03T00:05:00.000Z",
      messageId: "msg-001",
      pdfSizeBytes: 1024,
      recipientToHash: "abc",
      recipientCcHashes: [],
    });
    // 翌週 (別 occurrenceId)
    const nextWeek = await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_2,
      runId: RUN_2,
      now: "2026-06-10T00:00:00.000Z",
      leaseExpiresAt: "2026-06-10T00:10:00.000Z",
      ttlExpireAt: "2026-09-08T00:00:00.000Z",
    });
    expect(nextWeek).toEqual({ claimed: true });
  });
});

describe("InMemoryDispatchStorage.markProgressRecipientSent (三者一致 precondition)", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(async () => {
    storage = new InMemoryDispatchStorage();
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
  });

  it("status=pending + occurrenceId + runId 一致で sent 遷移成功", async () => {
    await storage.markProgressRecipientSent({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      sentAt: "2026-06-03T00:05:00.000Z",
      messageId: "msg-001",
      pdfSizeBytes: 2048,
      recipientToHash: "to-hash",
      recipientCcHashes: ["cc-1", "cc-2"],
    });
    const r = await storage.getProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
    });
    expect(r!.status).toBe("sent");
    expect(r!.messageId).toBe("msg-001");
    expect(r!.pdfSizeBytes).toBe(2048);
    expect(r!.recipientToHash).toBe("to-hash");
    expect(r!.recipientCcHashes).toEqual(["cc-1", "cc-2"]);
  });

  it("runId 不一致は throw (Codex HIGH-2: stale finalize 防止)", async () => {
    await expect(
      storage.markProgressRecipientSent({
        tenantId: TENANT_A,
        userId: USER_X,
        occurrenceId: OCCURRENCE_1,
        runId: RUN_2, // ← 不一致
        sentAt: "2026-06-03T00:05:00.000Z",
        messageId: "msg-001",
        pdfSizeBytes: 1024,
        recipientToHash: "abc",
        recipientCcHashes: [],
      }),
    ).rejects.toThrow(/runId mismatch/);
  });

  it("occurrenceId 不一致は throw (Codex HIGH-2)", async () => {
    await expect(
      storage.markProgressRecipientSent({
        tenantId: TENANT_A,
        userId: USER_X,
        occurrenceId: OCCURRENCE_2, // ← 不一致
        runId: RUN_1,
        sentAt: "2026-06-03T00:05:00.000Z",
        messageId: "msg-001",
        pdfSizeBytes: 1024,
        recipientToHash: "abc",
        recipientCcHashes: [],
      }),
    ).rejects.toThrow();
  });

  it("status=pending 以外 (manual_review_required) は throw (lease 切れ降格後の stale finalize 防止)", async () => {
    // 強制降格
    await storage.promotePendingToManualReview({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      promotedAt: "2026-06-03T00:11:00.000Z",
    });
    await expect(
      storage.markProgressRecipientSent({
        tenantId: TENANT_A,
        userId: USER_X,
        occurrenceId: OCCURRENCE_1,
        runId: RUN_1,
        sentAt: "2026-06-03T00:12:00.000Z",
        messageId: "msg-001",
        pdfSizeBytes: 1024,
        recipientToHash: "abc",
        recipientCcHashes: [],
      }),
    ).rejects.toThrow(/status must be "pending"/);
  });
});

describe("InMemoryDispatchStorage.markProgressRecipientFailed (三者一致 precondition)", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(async () => {
    storage = new InMemoryDispatchStorage();
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
  });

  it("三者一致で failed 遷移成功", async () => {
    await storage.markProgressRecipientFailed({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      failedAt: "2026-06-03T00:05:00.000Z",
      errorCode: "permanent_400",
      errorMessage: "Bad request",
    });
    const r = await storage.getProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
    });
    expect(r!.status).toBe("failed");
    expect(r!.errorCode).toBe("permanent_400");
  });

  it("runId 不一致は throw", async () => {
    await expect(
      storage.markProgressRecipientFailed({
        tenantId: TENANT_A,
        userId: USER_X,
        occurrenceId: OCCURRENCE_1,
        runId: RUN_2,
        failedAt: "2026-06-03T00:05:00.000Z",
        errorCode: "x",
        errorMessage: "x",
      }),
    ).rejects.toThrow(/runId mismatch/);
  });
});

describe("InMemoryDispatchStorage.promotePendingToManualReview", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(async () => {
    storage = new InMemoryDispatchStorage();
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
  });

  it("status=pending のみ降格可能", async () => {
    await storage.promotePendingToManualReview({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      promotedAt: "2026-06-03T00:11:00.000Z",
    });
    const r = await storage.getProgressRecipient({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
    });
    expect(r!.status).toBe("manual_review_required");
    expect(r!.promotedAt).toBe("2026-06-03T00:11:00.000Z");
  });

  it("既に sent 済 → throw (一貫性優先)", async () => {
    await storage.markProgressRecipientSent({
      tenantId: TENANT_A,
      userId: USER_X,
      occurrenceId: OCCURRENCE_1,
      runId: RUN_1,
      sentAt: "2026-06-03T00:05:00.000Z",
      messageId: "msg-001",
      pdfSizeBytes: 1024,
      recipientToHash: "abc",
      recipientCcHashes: [],
    });
    await expect(
      storage.promotePendingToManualReview({
        tenantId: TENANT_A,
        userId: USER_X,
        occurrenceId: OCCURRENCE_1,
        promotedAt: "2026-06-03T00:11:00.000Z",
      }),
    ).rejects.toThrow(/status must be "pending"/);
  });
});

describe("InMemoryDispatchStorage lane lock (AC-PR-09)", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("初回 acquire 成功", async () => {
    const outcome = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      occurrenceId: OCCURRENCE_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.lock.laneId).toBe("progress");
      expect(outcome.lock.ownerRunId).toBe(RUN_1);
      expect(outcome.lock.occurrenceId).toBe(OCCURRENCE_1);
    }
  });

  it("lease 期限内の同 lane 並行 acquire は reject (AC-PR-09)", async () => {
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    const dup = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(dup.acquired).toBe(false);
    if (!dup.acquired) {
      expect(dup.reason).toBe("lane_lock_held_by_other_run");
      expect(dup.currentLock.ownerRunId).toBe(RUN_1);
    }
  });

  it("lease 切れの旧 lock は新 run が上書き取得できる", async () => {
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    // 11 分後 (lease 切れ)
    const outcome = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: "2026-06-03T00:11:00.000Z",
      leaseExpiresAt: "2026-06-03T00:21:00.000Z",
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.lock.ownerRunId).toBe(RUN_2);
    }
  });

  it("両 lane (completion / progress) は独立して取得可能", async () => {
    await storage.acquireLaneLock({
      laneId: "completion",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    const progress = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(progress.acquired).toBe(true);
  });

  it("completeLaneLock: ownerRunId 一致で削除", async () => {
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    await storage.completeLaneLock({ laneId: "progress", ownerRunId: RUN_1 });
    // 削除後は新 run が即取得可能
    const newAcquire = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(newAcquire.acquired).toBe(true);
  });

  it("completeLaneLock: ownerRunId 不一致は no-op (Codex MEDIUM: 古い run が新 lock を消さない)", async () => {
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    // 旧 run RUN_OLD が complete を試みても削除されない
    await storage.completeLaneLock({ laneId: "progress", ownerRunId: "run-old" });
    // RUN_1 が現役 → 別 run の取得は依然 reject
    const dup = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(dup.acquired).toBe(false);
  });

  it("abortLaneLock: ownerRunId 一致で削除", async () => {
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    await storage.abortLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      abortedReason: "scope_revoked",
    });
    const newAcquire = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(newAcquire.acquired).toBe(true);
  });

  it("abortLaneLock: ownerRunId 不一致は no-op", async () => {
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_1,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    await storage.abortLaneLock({
      laneId: "progress",
      ownerRunId: "run-old",
      abortedReason: "x",
    });
    const dup = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: RUN_2,
      now: NOW,
      leaseExpiresAt: LEASE_10MIN,
    });
    expect(dup.acquired).toBe(false);
  });
});

describe("InMemoryDispatchStorage.acquireRunLock (Phase 3 laneId/occurrenceId 反映)", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("laneId/occurrenceId を渡せば doc に保存される", async () => {
    const outcome = await storage.acquireRunLock({
      runId: RUN_1,
      laneId: "progress",
      occurrenceId: OCCURRENCE_1,
      triggeredAt: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.run.laneId).toBe("progress");
      expect(outcome.run.occurrenceId).toBe(OCCURRENCE_1);
    }
    const run = await storage.getRun(RUN_1);
    expect(run!.laneId).toBe("progress");
    expect(run!.occurrenceId).toBe(OCCURRENCE_1);
  });

  it("laneId/occurrenceId 省略 (完了通知レーンの後方互換) でも acquire 可", async () => {
    const outcome = await storage.acquireRunLock({
      runId: RUN_1,
      triggeredAt: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.run.laneId).toBeUndefined();
      expect(outcome.run.occurrenceId).toBeUndefined();
    }
  });

  // ADR-039 D-1 / code-review HIGH 反映: 別 lane の running は排他対象外
  it("completion lane 起動中でも progress lane を acquire 可 (lane 独立)", async () => {
    // 完了通知レーン (laneId 省略 = "completion" 扱い) の run を取得
    await storage.acquireRunLock({
      runId: "completion-run",
      triggeredAt: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    // 進捗レポートレーンの run は同じ時刻でも acquire 可能
    const progress = await storage.acquireRunLock({
      runId: "progress-run",
      laneId: "progress",
      occurrenceId: OCCURRENCE_1,
      triggeredAt: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    expect(progress.acquired).toBe(true);
  });

  it("同 lane (progress) で 2 件目の acquire は another_run_active で reject (既存挙動)", async () => {
    await storage.acquireRunLock({
      runId: "progress-run-1",
      laneId: "progress",
      occurrenceId: OCCURRENCE_1,
      triggeredAt: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    const dup = await storage.acquireRunLock({
      runId: "progress-run-2",
      laneId: "progress",
      occurrenceId: OCCURRENCE_1,
      triggeredAt: NOW,
      leaseExpiresAt: LEASE_10MIN,
      ttlExpireAt: TTL_90D,
    });
    expect(dup.acquired).toBe(false);
    if (!dup.acquired) {
      expect(dup.reason).toBe("another_run_active");
    }
  });
});
