/**
 * InMemoryDispatchStorage の Phase 5 追加メソッド (updateDispatchSettings / listRuns) テスト。
 *
 * - updateDispatchSettings: 楽観的ロック (version) の作成 / 更新 / 競合 / increment
 * - listRuns: 全件取得 (route 層で並び替え・paginate する前提)
 *
 * 既存 reservation / run-lock の atomicity は reservation.test.ts / run-lock.test.ts で担保済。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";

const BASE_INPUT = {
  enabled: true,
  scheduleDaysOfWeek: [1, 4],
  scheduleHourJst: 9,
  signatureName: "DXcollege運営スタッフ",
  completionMessageBody: "受講お疲れ様でした。",
  senderEmail: "dxcollege@279279.net",
  updatedBy: "admin@example.com",
  updatedAt: "2026-05-22T01:00:00.000Z",
};

describe("InMemoryDispatchStorage.updateDispatchSettings", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("doc 未作成 + expectedVersion=0 で作成され version=1 になる", async () => {
    const result = await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 0,
    });
    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("unreachable");
    expect(result.settings.version).toBe(1);
    expect(result.settings.enabled).toBe(true);
    expect(result.settings.senderEmail).toBe("dxcollege@279279.net");

    const persisted = await storage.getDispatchSettings();
    expect(persisted?.version).toBe(1);
  });

  it("doc 未作成 + expectedVersion≠0 は version_conflict (current=null)", async () => {
    const result = await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 5,
    });
    expect(result.updated).toBe(false);
    if (result.updated) throw new Error("unreachable");
    expect(result.reason).toBe("version_conflict");
    expect(result.current).toBeNull();
    // 失敗時は書き込まれない
    expect(await storage.getDispatchSettings()).toBeNull();
  });

  it("既存 version 一致で更新され version が +1 される", async () => {
    await storage.updateDispatchSettings({ ...BASE_INPUT, expectedVersion: 0 }); // → v1
    const result = await storage.updateDispatchSettings({
      ...BASE_INPUT,
      enabled: false,
      expectedVersion: 1,
    });
    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("unreachable");
    expect(result.settings.version).toBe(2);
    expect(result.settings.enabled).toBe(false);
  });

  it("既存 version 不一致は version_conflict で現在値を返す (上書きされない)", async () => {
    await storage.updateDispatchSettings({ ...BASE_INPUT, expectedVersion: 0 }); // → v1
    const result = await storage.updateDispatchSettings({
      ...BASE_INPUT,
      signatureName: "別スタッフ",
      expectedVersion: 0, // stale
    });
    expect(result.updated).toBe(false);
    if (result.updated) throw new Error("unreachable");
    expect(result.reason).toBe("version_conflict");
    expect(result.current?.version).toBe(1);
    expect(result.current?.signatureName).toBe("DXcollege運営スタッフ");
    // stale write は反映されない
    const persisted = await storage.getDispatchSettings();
    expect(persisted?.signatureName).toBe("DXcollege運営スタッフ");
  });
});

describe("InMemoryDispatchStorage.listRuns", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("run 未登録なら空配列", async () => {
    expect(await storage.listRuns()).toEqual([]);
  });

  it("acquireRunLock で登録した run を全件返す", async () => {
    await storage.acquireRunLock({
      runId: "run-1",
      triggeredAt: "2026-05-22T00:00:00.000Z",
      leaseExpiresAt: "2026-05-22T00:04:40.000Z",
      ttlExpireAt: "2027-05-22T00:00:00.000Z",
    });
    await storage.acquireRunLock({
      runId: "run-2",
      triggeredAt: "2026-05-22T01:00:00.000Z",
      leaseExpiresAt: "2026-05-22T01:04:40.000Z",
      ttlExpireAt: "2027-05-22T01:00:00.000Z",
    });
    const runs = await storage.listRuns();
    expect(runs).toHaveLength(2);
    const ids = runs.map((r) => r.runId).sort();
    expect(ids).toEqual(["run-1", "run-2"]);
  });
});
