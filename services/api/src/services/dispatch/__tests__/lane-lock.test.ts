/**
 * lane-lock.ts helper の薄いテスト (storage delegation + lease 計算)。
 *
 * 関連: ADR-039 D-4、AC-PR-09 (lane lock 排他)
 *
 * storage 層 (acquireLaneLock 等) の transactional 排他は
 * in-memory-dispatch-storage-progress.test.ts でカバー済。
 * 本ファイルは helper の lease 計算 + delegation のみ検証。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import {
  acquireLaneLockOrSkip,
  completeLaneLock,
  abortLaneLock,
} from "../lane-lock.js";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";

describe("acquireLaneLockOrSkip", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("now から PROGRESS_REPORT_LANE_LOCK_LEASE_MS で leaseExpiresAt を算出して storage に渡す", async () => {
    const now = new Date("2026-06-03T00:00:00.000Z");
    const expectedLease = new Date(
      now.getTime() + DISPATCH_CONSTRAINTS.PROGRESS_REPORT_LANE_LOCK_LEASE_MS,
    ).toISOString();
    const outcome = await acquireLaneLockOrSkip(storage, {
      laneId: "progress",
      ownerRunId: "run-1",
      occurrenceId: "occ-1",
      now,
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.lock.leaseExpiresAt).toBe(expectedLease);
      expect(outcome.lock.acquiredAt).toBe(now.toISOString());
    }
  });

  it("occurrenceId 省略 (完了通知レーン想定) でも acquire 可", async () => {
    const outcome = await acquireLaneLockOrSkip(storage, {
      laneId: "completion",
      ownerRunId: "run-1",
      now: new Date("2026-06-03T00:00:00.000Z"),
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.lock.occurrenceId).toBeUndefined();
    }
  });
});

describe("completeLaneLock / abortLaneLock (delegation)", () => {
  it("completeLaneLock は storage.completeLaneLock を呼ぶ", async () => {
    const storage = new InMemoryDispatchStorage();
    const spy = vi.spyOn(storage, "completeLaneLock");
    await completeLaneLock(storage, "progress", "run-1");
    expect(spy).toHaveBeenCalledWith({ laneId: "progress", ownerRunId: "run-1" });
  });

  it("abortLaneLock は abortedReason を含めて storage.abortLaneLock を呼ぶ", async () => {
    const storage = new InMemoryDispatchStorage();
    const spy = vi.spyOn(storage, "abortLaneLock");
    await abortLaneLock(storage, "progress", "run-1", "scope_revoked");
    expect(spy).toHaveBeenCalledWith({
      laneId: "progress",
      ownerRunId: "run-1",
      abortedReason: "scope_revoked",
    });
  });
});
