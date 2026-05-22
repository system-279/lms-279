/**
 * createDispatchDryRunRouter (Phase 5 POST /super/dispatch/dry-run)。
 *
 * AC-8: 100% 完了対象を返すが Gmail 送信も Reservation も実行しない。
 * - eligible & email 有効 & 未通知 のみ wouldNotify に含む
 * - tenant disable / published 0 / 未完了 / email 無効 / 既通知 は除外
 * - storage に予約 (reserved) が作られないこと
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { InMemoryDispatchStorage } from "../../../services/dispatch/in-memory-dispatch-storage.js";
import {
  InMemoryTenantDataLoader,
  type InMemoryTenantFixture,
} from "../../../services/dispatch/tenant-data-loader.js";
import { createDispatchDryRunRouter } from "../dispatch-dry-run.js";

const NOW_ISO = "2026-05-22T01:00:00.000Z";

function makeApp(
  storage: InMemoryDispatchStorage,
  loader: InMemoryTenantDataLoader,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { superAdmin?: { email: string } }).superAdmin = {
      email: "admin@example.com",
    };
    next();
  });
  app.use(
    "/api/v2/super",
    createDispatchDryRunRouter({ storage, loader, now: () => new Date(NOW_ISO) }),
  );
  return app;
}

/** 1 published course (lesson 2 件) を完了している fixture を作る */
function completedFixture(
  users: { id: string; email: string; name: string }[],
  completedUserIds: string[],
): InMemoryTenantFixture {
  const courseProgresses = new Map<
    string,
    {
      courseId: string;
      isCompleted: boolean;
      totalLessons: number;
      completedLessons: number;
    }[]
  >();
  for (const u of users) {
    const done = completedUserIds.includes(u.id);
    courseProgresses.set(u.id, [
      {
        courseId: "c1",
        isCompleted: done,
        totalLessons: 2,
        completedLessons: done ? 2 : 1,
      },
    ]);
  }
  return {
    publishedCourses: [{ id: "c1", lessonOrder: ["l1", "l2"] }],
    users,
    courseProgresses,
    ccConfig: {
      completionNotificationEnabled: true,
      ownerEmail: "owner@example.com",
      notificationCcEmails: [],
    },
  };
}

describe("POST /super/dispatch/dry-run", () => {
  let storage: InMemoryDispatchStorage;
  let loader: InMemoryTenantDataLoader;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
    loader = new InMemoryTenantDataLoader();
  });

  it("100% 完了 & 未完了が混在 → 完了者のみ wouldNotify", async () => {
    loader.setTenant(
      "t1",
      completedFixture(
        [
          { id: "u1", email: "u1@example.com", name: "User 1" },
          { id: "u2", email: "u2@example.com", name: "User 2" },
        ],
        ["u1"],
      ),
    );
    const res = await request(makeApp(storage, loader)).post(
      "/api/v2/super/dispatch/dry-run",
    );
    expect(res.status).toBe(200);
    expect(res.body.wouldNotify).toHaveLength(1);
    expect(res.body.wouldNotify[0]).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      userEmail: "u1@example.com",
      userName: "User 1",
    });
    expect(res.body.evaluatedAt).toBe(NOW_ISO);
    // Reservation は作られない (AC-8)
    expect(await storage.getCompletionNotification("t1", "u1")).toBeNull();
  });

  it("テナント disable は対象外", async () => {
    const fx = completedFixture(
      [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      ["u1"],
    );
    fx.ccConfig = { ...fx.ccConfig!, completionNotificationEnabled: false };
    loader.setTenant("t1", fx);
    const res = await request(makeApp(storage, loader)).post(
      "/api/v2/super/dispatch/dry-run",
    );
    expect(res.body.wouldNotify).toHaveLength(0);
  });

  it("email 無効な完了者は除外", async () => {
    loader.setTenant(
      "t1",
      completedFixture([{ id: "u1", email: "  ", name: "User 1" }], ["u1"]),
    );
    const res = await request(makeApp(storage, loader)).post(
      "/api/v2/super/dispatch/dry-run",
    );
    expect(res.body.wouldNotify).toHaveLength(0);
  });

  it("既に通知済 (completion_notification 存在) の完了者は除外", async () => {
    loader.setTenant(
      "t1",
      completedFixture([{ id: "u1", email: "u1@example.com", name: "User 1" }], ["u1"]),
    );
    // 既存 reservation を作る (sent 相当の存在)
    await storage.tryReserveCompletionNotification({
      tenantId: "t1",
      userId: "u1",
      runId: "prev-run",
      now: "2026-05-20T00:00:00.000Z",
      leaseExpiresAt: "2026-05-20T00:10:00.000Z",
    });
    const res = await request(makeApp(storage, loader)).post(
      "/api/v2/super/dispatch/dry-run",
    );
    expect(res.body.wouldNotify).toHaveLength(0);
  });
});
