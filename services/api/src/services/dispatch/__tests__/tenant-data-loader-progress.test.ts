/**
 * InMemoryTenantDataLoader の Phase 3 進捗レポート対象判定テスト。
 *
 * 関連 ADR: ADR-039 D-5 (受講中フィルタ厳密化、Plan A 簡素化版)
 *
 * カバー:
 *   - listProgressReportTargetUsers の 4 軸フィルタ (role 既存 + 期限 + 進捗 1%)
 *   - getTenantInfo の default 値 (progressReportEnabled 未設定 → false)
 *
 * Plan A 採用 (ADR-039 D-5 修正済): 退会判定・enrollment 存在判定は Firestore
 * schema 不在のため本 PR スコープ外。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryTenantDataLoader } from "../tenant-data-loader.js";

const TENANT = "tenant-A";
const NOW = new Date("2026-06-03T00:00:00.000Z");

describe("InMemoryTenantDataLoader.listProgressReportTargetUsers", () => {
  let loader: InMemoryTenantDataLoader;
  beforeEach(() => {
    loader = new InMemoryTenantDataLoader();
  });

  it("user は登録されているが progress 全くなし → 空配列", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      courseProgresses: new Map(),
      ccConfig: null,
    });
    const users = await loader
      .getTenantDataView(TENANT)
      .listProgressReportTargetUsers(NOW);
    expect(users).toEqual([]);
  });

  it("progress 0% は除外、1% 以上で送信対象", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [
        { id: "u1", email: "u1@example.com", name: "User 1" }, // 0%
        { id: "u2", email: "u2@example.com", name: "User 2" }, // ちょうど 1%
        { id: "u3", email: "u3@example.com", name: "User 3" }, // 50%
      ],
      courseProgresses: new Map([
        ["u1", [{ courseId: "c1", isCompleted: false, totalLessons: 100, completedLessons: 0 }]],
        ["u2", [{ courseId: "c1", isCompleted: false, totalLessons: 100, completedLessons: 1 }]],
        ["u3", [{ courseId: "c1", isCompleted: false, totalLessons: 100, completedLessons: 50 }]],
      ]),
      ccConfig: null,
    });
    const users = await loader
      .getTenantDataView(TENANT)
      .listProgressReportTargetUsers(NOW);
    expect(users.map((u) => u.id).sort()).toEqual(["u2", "u3"]);
  });

  it("複数コースの合計進捗で判定 (1 つは 0%、もう 1 つに 1% あれば pass)", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      courseProgresses: new Map([
        [
          "u1",
          [
            { courseId: "c1", isCompleted: false, totalLessons: 100, completedLessons: 0 },
            { courseId: "c2", isCompleted: false, totalLessons: 100, completedLessons: 2 },
          ],
        ],
      ]),
      ccConfig: null,
    });
    const users = await loader
      .getTenantDataView(TENANT)
      .listProgressReportTargetUsers(NOW);
    // 合計: 2/200 = 1% (>= 0.01) → pass
    expect(users.map((u) => u.id)).toEqual(["u1"]);
  });

  it("videoAccessUntil 期限切れ → 全 user 除外 (AC-PR-03)", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      courseProgresses: new Map([
        ["u1", [{ courseId: "c1", isCompleted: false, totalLessons: 100, completedLessons: 50 }]],
      ]),
      ccConfig: null,
      videoAccessUntil: "2026-05-01T00:00:00.000Z", // now (2026-06-03) より前
    });
    const users = await loader
      .getTenantDataView(TENANT)
      .listProgressReportTargetUsers(NOW);
    expect(users).toEqual([]);
  });

  it("videoAccessUntil 未指定なら期限なし (進捗条件のみで判定)", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      courseProgresses: new Map([
        ["u1", [{ courseId: "c1", isCompleted: false, totalLessons: 100, completedLessons: 30 }]],
      ]),
      ccConfig: null,
      // videoAccessUntil 未指定
    });
    const users = await loader
      .getTenantDataView(TENANT)
      .listProgressReportTargetUsers(NOW);
    expect(users.map((u) => u.id)).toEqual(["u1"]);
  });

  it("totalLessons=0 の course しかない user は除外 (ゼロ除算回避)", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      courseProgresses: new Map([
        ["u1", [{ courseId: "c1", isCompleted: false, totalLessons: 0, completedLessons: 0 }]],
      ]),
      ccConfig: null,
    });
    const users = await loader
      .getTenantDataView(TENANT)
      .listProgressReportTargetUsers(NOW);
    expect(users).toEqual([]);
  });
});

describe("InMemoryTenantDataLoader.getTenantInfo", () => {
  let loader: InMemoryTenantDataLoader;
  beforeEach(() => {
    loader = new InMemoryTenantDataLoader();
  });

  it("未登録 tenant は null", async () => {
    const info = await loader.getTenantInfo("unknown");
    expect(info).toBeNull();
  });

  it("info 未指定 fixture の default: active=true, progressReportEnabled=false (opt-in)", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [],
      courseProgresses: new Map(),
      ccConfig: null,
    });
    const info = await loader.getTenantInfo(TENANT);
    expect(info).toEqual({
      tenantId: TENANT,
      active: true,
      progressReportEnabled: false,
    });
  });

  it("info で progressReportEnabled=true 指定すれば反映 (opt-in 後)", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [],
      courseProgresses: new Map(),
      ccConfig: null,
      info: { active: true, progressReportEnabled: true },
    });
    const info = await loader.getTenantInfo(TENANT);
    expect(info!.progressReportEnabled).toBe(true);
  });

  it("active=false (suspended) を表現可能", async () => {
    loader.setTenant(TENANT, {
      publishedCourses: [],
      users: [],
      courseProgresses: new Map(),
      ccConfig: null,
      info: { active: false, progressReportEnabled: false },
    });
    const info = await loader.getTenantInfo(TENANT);
    expect(info!.active).toBe(false);
  });
});
