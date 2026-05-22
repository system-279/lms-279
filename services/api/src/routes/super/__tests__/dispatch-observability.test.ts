/**
 * createDispatchAuditLogsRouter / createDispatchRunsRouter (Phase 5 観測 API)。
 *
 * - audit-logs: tenantId/userId/eventType/from/to フィルタ + createdAt 降順 + cursor paginate
 * - runs: triggeredAt 降順 + cursor paginate
 *
 * InMemoryDispatchStorage に直接データを投入して検証。
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { InMemoryDispatchStorage } from "../../../services/dispatch/in-memory-dispatch-storage.js";
import { createDispatchAuditLogsRouter } from "../dispatch-audit-logs.js";
import { createDispatchRunsRouter } from "../dispatch-runs.js";

const TTL = "2027-05-22T00:00:00.000Z";

function makeApp(
  storage: InMemoryDispatchStorage,
  which: "audit-logs" | "runs",
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
    which === "audit-logs"
      ? createDispatchAuditLogsRouter({ storage })
      : createDispatchRunsRouter({ storage }),
  );
  return app;
}

async function seedAudit(
  storage: InMemoryDispatchStorage,
  args: {
    auditId: string;
    createdAt: string;
    tenantId?: string | null;
    userId?: string | null;
    eventType?: "run_started" | "user_notified" | "test_send";
  },
) {
  await storage.appendAuditLog({
    auditId: args.auditId,
    runId: "run-x",
    runStartedAt: args.createdAt,
    eventType: args.eventType ?? "user_notified",
    tenantId: args.tenantId ?? null,
    userId: args.userId ?? null,
    errorCode: null,
    errorMessage: null,
    durationMs: null,
    createdAt: args.createdAt,
    ttlExpireAt: TTL,
  });
}

describe("GET /super/dispatch/audit-logs", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("createdAt 降順で返す", async () => {
    await seedAudit(storage, { auditId: "a1", createdAt: "2026-05-20T00:00:00.000Z" });
    await seedAudit(storage, { auditId: "a2", createdAt: "2026-05-22T00:00:00.000Z" });
    await seedAudit(storage, { auditId: "a3", createdAt: "2026-05-21T00:00:00.000Z" });
    const res = await request(makeApp(storage, "audit-logs")).get(
      "/api/v2/super/dispatch/audit-logs",
    );
    expect(res.status).toBe(200);
    expect(res.body.logs.map((l: { auditId: string }) => l.auditId)).toEqual([
      "a2",
      "a3",
      "a1",
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("tenantId フィルタが効く", async () => {
    await seedAudit(storage, { auditId: "a1", createdAt: "2026-05-20T00:00:00.000Z", tenantId: "t1" });
    await seedAudit(storage, { auditId: "a2", createdAt: "2026-05-21T00:00:00.000Z", tenantId: "t2" });
    const res = await request(makeApp(storage, "audit-logs")).get(
      "/api/v2/super/dispatch/audit-logs?tenantId=t1",
    );
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].auditId).toBe("a1");
  });

  it("eventType フィルタが効く", async () => {
    await seedAudit(storage, { auditId: "a1", createdAt: "2026-05-20T00:00:00.000Z", eventType: "test_send" });
    await seedAudit(storage, { auditId: "a2", createdAt: "2026-05-21T00:00:00.000Z", eventType: "user_notified" });
    const res = await request(makeApp(storage, "audit-logs")).get(
      "/api/v2/super/dispatch/audit-logs?eventType=test_send",
    );
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].auditId).toBe("a1");
  });

  it("from/to の範囲フィルタが効く", async () => {
    await seedAudit(storage, { auditId: "a1", createdAt: "2026-05-19T00:00:00.000Z" });
    await seedAudit(storage, { auditId: "a2", createdAt: "2026-05-21T00:00:00.000Z" });
    await seedAudit(storage, { auditId: "a3", createdAt: "2026-05-23T00:00:00.000Z" });
    const res = await request(makeApp(storage, "audit-logs")).get(
      "/api/v2/super/dispatch/audit-logs?from=2026-05-20T00:00:00.000Z&to=2026-05-22T00:00:00.000Z",
    );
    expect(res.body.logs.map((l: { auditId: string }) => l.auditId)).toEqual(["a2"]);
  });

  it("limit + cursor でページングできる", async () => {
    for (let i = 1; i <= 5; i++) {
      await seedAudit(storage, {
        auditId: `a${i}`,
        createdAt: `2026-05-2${i}T00:00:00.000Z`,
      });
    }
    const p1 = await request(makeApp(storage, "audit-logs")).get(
      "/api/v2/super/dispatch/audit-logs?limit=2",
    );
    expect(p1.body.logs.map((l: { auditId: string }) => l.auditId)).toEqual(["a5", "a4"]);
    expect(p1.body.nextCursor).toBe("a4");

    const p2 = await request(makeApp(storage, "audit-logs")).get(
      `/api/v2/super/dispatch/audit-logs?limit=2&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.logs.map((l: { auditId: string }) => l.auditId)).toEqual(["a3", "a2"]);
    expect(p2.body.nextCursor).toBe("a2");
  });
});

describe("GET /super/dispatch/runs", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  async function seedRun(runId: string, triggeredAt: string) {
    // leaseExpiresAt は常に過去固定にして acquireRunLock の重複ガード
    // (running かつ lease 期限内の run があると別 run を拒否) を回避し、
    // seed 順序に依存せず複数 run を登録できるようにする。
    await storage.acquireRunLock({
      runId,
      triggeredAt,
      leaseExpiresAt: "2020-01-01T00:00:00.000Z",
      ttlExpireAt: TTL,
    });
  }

  it("triggeredAt 降順で返す", async () => {
    await seedRun("r1", "2026-05-20T00:00:00.000Z");
    await seedRun("r2", "2026-05-22T00:00:00.000Z");
    await seedRun("r3", "2026-05-21T00:00:00.000Z");
    const res = await request(makeApp(storage, "runs")).get(
      "/api/v2/super/dispatch/runs",
    );
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { runId: string }) => r.runId)).toEqual([
      "r2",
      "r3",
      "r1",
    ]);
  });

  it("limit + cursor でページングできる", async () => {
    await seedRun("r1", "2026-05-20T00:00:00.000Z");
    await seedRun("r2", "2026-05-21T00:00:00.000Z");
    await seedRun("r3", "2026-05-22T00:00:00.000Z");
    const p1 = await request(makeApp(storage, "runs")).get(
      "/api/v2/super/dispatch/runs?limit=2",
    );
    expect(p1.body.runs.map((r: { runId: string }) => r.runId)).toEqual(["r3", "r2"]);
    expect(p1.body.nextCursor).toBe("r2");
    const p2 = await request(makeApp(storage, "runs")).get(
      `/api/v2/super/dispatch/runs?limit=2&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.runs.map((r: { runId: string }) => r.runId)).toEqual(["r1"]);
    expect(p2.body.nextCursor).toBeNull();
  });
});
