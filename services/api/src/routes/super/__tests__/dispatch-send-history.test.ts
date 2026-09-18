/**
 * createDispatchSendHistoryRouter (PR2a GET /super/dispatch/send-history) の
 * integration test。
 *
 * 観点:
 *   - 単一テナント/単一レーンの基本一覧
 *   - 複数テナントを跨いだマージソート (processedAt 降順がテナント境界を越えて正しい)
 *   - lane / tenantId フィルタ
 *   - tenantName / userName / userEmail の join
 *   - cursor ページングで重複・欠落がない (page1+page2 = 全件)
 *   - 該当データなし → items=[] / nextCursor=null
 *
 * 認可は親で適用される前提のため fake superAdmin middleware を挟む (dispatch-dry-run.test.ts と同型)。
 */
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import type { GetSendHistoryResponse } from "@lms-279/shared-types";

import { InMemoryDispatchStorage } from "../../../services/dispatch/in-memory-dispatch-storage.js";
import { InMemoryTenantDataLoader } from "../../../services/dispatch/tenant-data-loader.js";
import { createDispatchSendHistoryRouter } from "../dispatch-send-history.js";

function makeApp(
  storage: InMemoryDispatchStorage,
  loader: InMemoryTenantDataLoader,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v2/super",
    createDispatchSendHistoryRouter({ storage, loader }),
  );
  return app;
}

describe("GET /api/v2/super/dispatch/send-history", () => {
  it("該当データが無ければ items=[] / nextCursor=null", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant("tenant-a", {
      publishedCourses: [],
      users: [],
      courseProgresses: new Map(),
      ccConfig: null,
    });
    const app = makeApp(storage, loader);

    const res = await request(app).get("/api/v2/super/dispatch/send-history");
    expect(res.status).toBe(200);
    const body = res.body as GetSendHistoryResponse;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("単一テナント: tenantName / userName / userEmail が join される", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant("tenant-a", {
      publishedCourses: [],
      users: [{ id: "user-1", email: "user1@example.com", name: "受講者一郎" }],
      courseProgresses: new Map(),
      ccConfig: null,
      name: "テナントA",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-a",
      userId: "user-1",
      runId: "run-1",
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/send-history?lane=completion",
    );
    expect(res.status).toBe(200);
    const body = res.body as GetSendHistoryResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      tenantId: "tenant-a",
      tenantName: "テナントA",
      userId: "user-1",
      userName: "受講者一郎",
      userEmail: "user1@example.com",
      lane: "completion",
      status: "reserved",
    });
  });

  it("複数テナントを跨いでも processedAt 降順にマージされる", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant("tenant-a", {
      publishedCourses: [],
      users: [{ id: "user-1", email: "a1@example.com", name: "A1" }],
      courseProgresses: new Map(),
      ccConfig: null,
      name: "テナントA",
    });
    loader.setTenant("tenant-b", {
      publishedCourses: [],
      users: [{ id: "user-2", email: "b1@example.com", name: "B1" }],
      courseProgresses: new Map(),
      ccConfig: null,
      name: "テナントB",
    });
    // tenant-a は古い時刻、tenant-b は新しい時刻で予約 → tenant-b が先頭に来るはず
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-a",
      userId: "user-1",
      runId: "run-1",
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-b",
      userId: "user-2",
      runId: "run-1",
      now: "2026-06-03T02:00:00.000Z",
      leaseExpiresAt: "2026-06-03T02:10:00.000Z",
    });
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/send-history?lane=completion",
    );
    const body = res.body as GetSendHistoryResponse;
    expect(body.items.map((i) => i.tenantId)).toEqual(["tenant-b", "tenant-a"]);
  });

  it("tenantId フィルタで対象テナントのみ返す", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    for (const t of ["tenant-a", "tenant-b"]) {
      loader.setTenant(t, {
        publishedCourses: [],
        users: [{ id: "user-1", email: "u@example.com", name: "U" }],
        courseProgresses: new Map(),
        ccConfig: null,
        name: t,
      });
      await storage.tryReserveCompletionNotification({
        tenantId: t,
        userId: "user-1",
        runId: "run-1",
        now: "2026-06-03T01:00:00.000Z",
        leaseExpiresAt: "2026-06-03T01:10:00.000Z",
      });
    }
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/send-history?tenantId=tenant-a",
    );
    const body = res.body as GetSendHistoryResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tenantId).toBe("tenant-a");
  });

  it("cursor ページングで全件を重複・欠落なく走査できる", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant("tenant-a", {
      publishedCourses: [],
      users: [
        { id: "user-1", email: "u1@example.com", name: "U1" },
        { id: "user-2", email: "u2@example.com", name: "U2" },
        { id: "user-3", email: "u3@example.com", name: "U3" },
      ],
      courseProgresses: new Map(),
      ccConfig: null,
      name: "テナントA",
    });
    let t = 1;
    for (const userId of ["user-1", "user-2", "user-3"]) {
      await storage.tryReserveCompletionNotification({
        tenantId: "tenant-a",
        userId,
        runId: "run-1",
        now: `2026-06-03T0${t}:00:00.000Z`,
        leaseExpiresAt: `2026-06-03T0${t}:10:00.000Z`,
      });
      t += 1;
    }
    const app = makeApp(storage, loader);

    const page1 = await request(app).get(
      "/api/v2/super/dispatch/send-history?lane=completion&limit=2",
    );
    const body1 = page1.body as GetSendHistoryResponse;
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await request(app).get(
      `/api/v2/super/dispatch/send-history?lane=completion&limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`,
    );
    const body2 = page2.body as GetSendHistoryResponse;

    const allUserIds = [...body1.items, ...body2.items].map((i) => i.userId).sort();
    expect(allUserIds).toEqual(["user-1", "user-2", "user-3"]);
    expect(new Set(allUserIds).size).toBe(3);
  });

  it("複数テナント (複数シャード) を跨ぐ cursor ページングでも重複・欠落なく全件走査でき、ページ間の降順も保たれる (fable-review M4 反映)", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    // tenant-a/tenant-b それぞれ2件ずつ (=2シャード×2件)、時刻を交互に配置して
    // 単純な「シャードごと順番に消費」では正しくソートできないことを検証する
    for (const t of ["tenant-a", "tenant-b"]) {
      loader.setTenant(t, {
        publishedCourses: [],
        users: [
          { id: `${t}-user-1`, email: `${t}1@example.com`, name: `${t}-1` },
          { id: `${t}-user-2`, email: `${t}2@example.com`, name: `${t}-2` },
        ],
        courseProgresses: new Map(),
        ccConfig: null,
        name: t,
      });
    }
    // 時刻降順で並べると: b-user-2(04) > a-user-2(03) > b-user-1(02) > a-user-1(01)
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-a", userId: "tenant-a-user-1", runId: "run-1",
      now: "2026-06-03T01:00:00.000Z", leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-b", userId: "tenant-b-user-1", runId: "run-1",
      now: "2026-06-03T02:00:00.000Z", leaseExpiresAt: "2026-06-03T02:10:00.000Z",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-a", userId: "tenant-a-user-2", runId: "run-1",
      now: "2026-06-03T03:00:00.000Z", leaseExpiresAt: "2026-06-03T03:10:00.000Z",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-b", userId: "tenant-b-user-2", runId: "run-1",
      now: "2026-06-03T04:00:00.000Z", leaseExpiresAt: "2026-06-03T04:10:00.000Z",
    });
    const app = makeApp(storage, loader);

    // limit=1 で1件ずつページングし、シャード境界を跨いだカーソル継続を強制する
    const expectedOrder = [
      "tenant-b-user-2",
      "tenant-a-user-2",
      "tenant-b-user-1",
      "tenant-a-user-1",
    ];
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < expectedOrder.length; i += 1) {
      const qs = new URLSearchParams({ lane: "completion", limit: "1" });
      if (cursor) qs.set("cursor", cursor);
      const res = await request(app).get(`/api/v2/super/dispatch/send-history?${qs.toString()}`);
      const body = res.body as GetSendHistoryResponse;
      expect(body.items).toHaveLength(1);
      collected.push(body.items[0].userId);
      cursor = body.nextCursor;
    }
    expect(collected).toEqual(expectedOrder);
    // 全件消費後は空ページで終端
    const finalQs = new URLSearchParams({ lane: "completion", limit: "1" });
    if (cursor) finalQs.set("cursor", cursor);
    const finalRes = await request(app).get(`/api/v2/super/dispatch/send-history?${finalQs.toString()}`);
    expect((finalRes.body as GetSendHistoryResponse).items).toEqual([]);
  });

  it("同一 processedAt がテナント (シャード) を跨いでも欠落しない (tiebreaker)", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const SAME_TIME = "2026-06-03T01:00:00.000Z";
    for (const t of ["tenant-a", "tenant-b"]) {
      loader.setTenant(t, {
        publishedCourses: [],
        users: [{ id: `${t}-user-1`, email: `${t}@example.com`, name: t }],
        courseProgresses: new Map(),
        ccConfig: null,
        name: t,
      });
      await storage.tryReserveCompletionNotification({
        tenantId: t, userId: `${t}-user-1`, runId: "run-1",
        now: SAME_TIME, leaseExpiresAt: "2026-06-03T01:10:00.000Z",
      });
    }
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/send-history?lane=completion",
    );
    const body = res.body as GetSendHistoryResponse;
    expect(body.items.map((i) => i.userId).sort()).toEqual([
      "tenant-a-user-1",
      "tenant-b-user-1",
    ]);
  });

  it("lane 未指定 → completion/progress 両レーンが混在してマージされる (lane=all 相当)", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant("tenant-a", {
      publishedCourses: [],
      users: [{ id: "user-1", email: "u1@example.com", name: "U1" }],
      courseProgresses: new Map(),
      ccConfig: null,
      name: "テナントA",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: "tenant-a", userId: "user-1", runId: "run-1",
      now: "2026-06-03T01:00:00.000Z", leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });
    await storage.tryClaimProgressRecipient({
      tenantId: "tenant-a", userId: "user-1", occurrenceId: "occ-1", runId: "run-1",
      now: "2026-06-03T02:00:00.000Z",
      leaseExpiresAt: "2026-06-03T02:10:00.000Z",
      ttlExpireAt: "2026-09-03T02:00:00.000Z",
    });
    const app = makeApp(storage, loader);

    const res = await request(app).get("/api/v2/super/dispatch/send-history");
    const body = res.body as GetSendHistoryResponse;
    expect(body.items.map((i) => i.lane).sort()).toEqual(["completion", "progress"]);
  });
});
