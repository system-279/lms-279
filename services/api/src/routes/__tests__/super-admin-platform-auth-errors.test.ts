/**
 * GET /api/v2/super/platform/auth-errors (routes/super-admin.ts) の統合テスト
 *
 * Issue #299: platform_auth_error_logs の admin UI/API 読み取り経路追加
 *
 * 確認対象:
 *   - AC2: super-admin は 200 + { platformAuthErrorLogs: [...] } を日時降順で取得
 *   - AC3: 非 super-admin は 403 (既存 superAdminAuthMiddleware 経由)
 *   - AC5: filter (email / startDate / endDate / limit) が機能
 *   - AC6: invalid startDate → 400 invalid_start_date
 *   - AC7: invalid endDate → 400 invalid_end_date
 *   - AC8: startDate > endDate → 空配列（400 を返さない）
 *   - AC9: limit clamp (1-500, デフォルト 100, 不正値は 100)
 *   - AC10: 空結果 → 200 + { platformAuthErrorLogs: [] }
 *   - AC12: PII (email) は super-admin のみに返す（AC3 の裏付け）
 *
 * dev モード (X-User-Email ヘッダ + isSuperAdmin mock) で境界を検証する。
 * Firebase モードは既存の tenants.test.ts / help-role.test.ts と同じパターンで
 * verifyIdToken が走るため、本テストはスコープ外とする（別 Issue 起票可）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import type { AuthErrorLog } from "../../types/entities.js";

const PLATFORM_TENANT_ID = "__platform__";

// firebase-admin/firestore を mock: superAdmins コレクションは空で返す
// → isSuperAdmin の env fast path (SUPER_ADMIN_EMAILS) のみで判定させる
const mockGetDocs = vi.fn().mockResolvedValue({ docs: [] });
vi.mock("firebase-admin/firestore", () => {
  const makeFirestore = () => ({
    collection: () => ({
      get: mockGetDocs,
    }),
  });
  return {
    getFirestore: () => makeFirestore(),
    Timestamp: {
      fromDate: (d: Date) => ({ toDate: () => d, seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }),
    },
  };
});

// vi.resetModules() 後に platform-datasource の cached も null に戻るため、
// 各 test で buildApp 内で dynamic import + 注入する必要がある（module singleton の罠）。
async function buildApp(ds: InMemoryDataSource) {
  const { superAdminRouter } = await import("../super-admin.js");
  const { setPlatformDataSourceForTest } = await import("../../middleware/platform-datasource.js");
  setPlatformDataSourceForTest(ds);
  const app = express();
  app.use(express.json());
  app.use("/api/v2/super", superAdminRouter);
  return app;
}

function makeLog(overrides: Partial<AuthErrorLog> = {}): Omit<AuthErrorLog, "id"> {
  return {
    email: "denied@example.com",
    tenantId: PLATFORM_TENANT_ID,
    errorType: "super_admin_denied",
    reason: "not_super_admin",
    errorMessage: "Email not registered as super admin",
    path: "/api/v2/super/tenants",
    method: "GET",
    userAgent: null,
    ipAddress: null,
    firebaseErrorCode: null,
    occurredAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("GET /api/v2/super/platform/auth-errors (Issue #299)", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "dev");
    // env fast path で super@example.com を super-admin として認識させる
    vi.stubEnv("SUPER_ADMIN_EMAILS", "super@example.com");
    mockGetDocs.mockResolvedValue({ docs: [] });
    ds = new InMemoryDataSource({ readOnly: false });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { setPlatformDataSourceForTest } = await import("../../middleware/platform-datasource.js");
    setPlatformDataSourceForTest(null);
  });

  it("AC3: X-User-Email ヘッダ欠落時は 401 (superAdminAuthMiddleware)", async () => {
    const app = await buildApp(ds);
    const res = await supertest(app).get("/api/v2/super/platform/auth-errors");
    expect(res.status).toBe(401);
  });

  it("AC3: 非 super-admin (env/Firestore どちらにも無い) は 403", async () => {
    // notadmin@example.com は env に無く、Firestore mock も空 → false
    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors")
      .set("X-User-Email", "notadmin@example.com");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("AC10: super-admin で空結果時は 200 + 空配列", async () => {
    // super@example.com は env fast path で super-admin 判定される
    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors")
      .set("X-User-Email", "super@example.com");
    expect(res.status).toBe(200);
    expect(res.body.platformAuthErrorLogs).toEqual([]);
  });

  it("AC2: super-admin は日時降順でログリストを取得（createPlatformAuthErrorLog で書いた分が読める）", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T10:00:00.000Z", email: "a@example.com" }));
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T12:00:00.000Z", email: "b@example.com" }));
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T11:00:00.000Z", email: "c@example.com" }));

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    const logs = res.body.platformAuthErrorLogs as AuthErrorLog[];
    expect(logs).toHaveLength(3);
    expect(logs[0].email).toBe("b@example.com"); // 12:00
    expect(logs[1].email).toBe("c@example.com"); // 11:00
    expect(logs[2].email).toBe("a@example.com"); // 10:00
  });

  it("AC5: email フィルタで指定したメールのみ返る", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog({ email: "a@example.com" }));
    await ds.createPlatformAuthErrorLog(makeLog({ email: "b@example.com" }));

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?email=a@example.com")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    const logs = res.body.platformAuthErrorLogs as AuthErrorLog[];
    expect(logs).toHaveLength(1);
    expect(logs[0].email).toBe("a@example.com");
  });

  it("AC5: startDate/endDate フィルタで日時範囲が効く", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-20T00:00:00.000Z" }));
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T00:00:00.000Z" }));
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-24T00:00:00.000Z" }));

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?startDate=2026-04-21T00:00:00.000Z&endDate=2026-04-23T00:00:00.000Z")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    const logs = res.body.platformAuthErrorLogs as AuthErrorLog[];
    expect(logs).toHaveLength(1);
    expect(logs[0].occurredAt).toBe("2026-04-22T00:00:00.000Z");
  });

  it("AC8: startDate > endDate の場合は空配列を返す（400 ではない）", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T00:00:00.000Z" }));

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?startDate=2026-04-25T00:00:00.000Z&endDate=2026-04-20T00:00:00.000Z")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    expect(res.body.platformAuthErrorLogs).toEqual([]);
  });

  it("AC9: limit 明示指定 (1) で 1 件のみ返る", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T10:00:00.000Z" }));
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T11:00:00.000Z" }));
    await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: "2026-04-22T12:00:00.000Z" }));

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?limit=1")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    expect(res.body.platformAuthErrorLogs).toHaveLength(1);
  });

  it("AC9: limit=501 は 500 に clamp される（HTTP 端点）", async () => {
    // 501 件作成して clamp 動作を実測
    for (let i = 0; i < 501; i++) {
      const hour = String(Math.floor(i / 60)).padStart(2, "0");
      const min = String(i % 60).padStart(2, "0");
      await ds.createPlatformAuthErrorLog(makeLog({ occurredAt: `2026-04-22T${hour}:${min}:00.000Z` }));
    }

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?limit=501")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    expect(res.body.platformAuthErrorLogs).toHaveLength(500);
  });

  it("AC9: limit 不正値 (文字列 abc) は 100 にフォールバック", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog());

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?limit=abc")
      .set("X-User-Email", "super@example.com");

    // 100 デフォルトでフォールバック → 1件存在
    expect(res.status).toBe(200);
    expect(res.body.platformAuthErrorLogs).toHaveLength(1);
  });

  it("AC6: invalid startDate は 400 invalid_start_date", async () => {
    // super@example.com は env fast path で super-admin 判定される
    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?startDate=not-a-date")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_start_date");
  });

  it("AC7: invalid endDate は 400 invalid_end_date", async () => {
    // super@example.com は env fast path で super-admin 判定される
    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors?endDate=also-not-a-date")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_end_date");
  });

  it("AC12: response は PII (email) を含むが、super-admin のみアクセス可能 (AC3 の裏付け)", async () => {
    // super@example.com は env fast path で super-admin 判定される
    await ds.createPlatformAuthErrorLog(makeLog({ email: "pii@example.com", firebaseErrorCode: "auth/id-token-revoked" }));

    const app = await buildApp(ds);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(200);
    const logs = res.body.platformAuthErrorLogs as AuthErrorLog[];
    expect(logs[0].email).toBe("pii@example.com");
    expect(logs[0].firebaseErrorCode).toBe("auth/id-token-revoked");
  });

  it("DataSource 障害時は 500 fetch_failed を返す（evaluator 指摘）", async () => {
    // super@example.com は env fast path で super-admin 判定される
    // getPlatformAuthErrorLogs を reject させる
    const brokenDs = {
      ...ds,
      getPlatformAuthErrorLogs: vi.fn().mockRejectedValue(new Error("Firestore unavailable")),
      createPlatformAuthErrorLog: ds.createPlatformAuthErrorLog.bind(ds),
    } as unknown as InMemoryDataSource;

    const app = await buildApp(brokenDs);
    const res = await supertest(app)
      .get("/api/v2/super/platform/auth-errors")
      .set("X-User-Email", "super@example.com");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("fetch_failed");
  });
});
