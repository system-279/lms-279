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

describe("InMemoryDispatchStorage.updateDispatchSettings (Phase 3 patch semantics、AC-PR-18)", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("既存 progressReport は新規 PUT で progressReport 未送信なら保持される (HIGH-4 中核)", async () => {
    // 初回 create + progressReport ON
    await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 0,
      progressReport: {
        enabled: true,
        scheduleDaysOfWeek: [3],
        scheduleHourJst: 9,
      },
    });
    // 旧 UI からの PUT (progressReport 未送信) で完了通知 fields のみ更新
    const result = await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 1,
      enabled: false, // 完了通知だけ OFF にする操作
      updatedAt: "2026-05-22T02:00:00.000Z",
      // progressReport を渡さない
    });
    expect(result.updated).toBe(true);
    if (result.updated) {
      // 既存 progressReport が保持されている
      expect(result.settings.progressReport).toEqual({
        enabled: true,
        scheduleDaysOfWeek: [3],
        scheduleHourJst: 9,
      });
      // 完了通知側は更新された
      expect(result.settings.enabled).toBe(false);
    }
  });

  it("progressReport を新規追加できる (既存値なしから set)", async () => {
    await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 0,
    });
    const result = await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 1,
      updatedAt: "2026-05-22T02:00:00.000Z",
      progressReport: {
        enabled: true,
        scheduleDaysOfWeek: [4],
        scheduleHourJst: 11,
      },
    });
    expect(result.updated).toBe(true);
    if (result.updated) {
      expect(result.settings.progressReport).toEqual({
        enabled: true,
        scheduleDaysOfWeek: [4],
        scheduleHourJst: 11,
      });
    }
  });

  it("初回 create で必須 field 不足は throw (route 層で validate 済前提)", async () => {
    // 必須 field 抜き (completionMessageBody) で初回 create
    await expect(
      storage.updateDispatchSettings({
        expectedVersion: 0,
        enabled: true,
        scheduleDaysOfWeek: [1],
        scheduleHourJst: 9,
        signatureName: "x",
        // completionMessageBody 抜き
        senderEmail: "x@y.z",
        updatedBy: "a",
        updatedAt: "2026-05-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(/initial create requires all completion fields/);
  });

  it("既存 doc あり時に optional field 全て省略でも version + updatedAt + updatedBy のみ更新", async () => {
    await storage.updateDispatchSettings({
      ...BASE_INPUT,
      expectedVersion: 0,
    });
    const result = await storage.updateDispatchSettings({
      expectedVersion: 1,
      updatedBy: "different@example.com",
      updatedAt: "2026-05-22T05:00:00.000Z",
      // 全 settings field 省略
    });
    expect(result.updated).toBe(true);
    if (result.updated) {
      expect(result.settings.enabled).toBe(true); // 既存値保持
      expect(result.settings.scheduleDaysOfWeek).toEqual([1, 4]); // 既存値保持
      expect(result.settings.updatedBy).toBe("different@example.com"); // 更新
      expect(result.settings.version).toBe(2); // increment
    }
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
