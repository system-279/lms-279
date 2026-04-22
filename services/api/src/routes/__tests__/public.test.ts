/**
 * GET /api/v2/public/tenants/:tenantId (routes/public.ts) の統合テスト
 *
 * ADR-031 Phase 3 Sub-Issue B: 認証不要の公開テナント情報 endpoint。
 *
 * 検証対象:
 *   - 正常系: active / suspended の両方で 200 を返す
 *   - 404: 未登録 / RESERVED_TENANT_IDS / 不正フォーマット（enumeration 防止のため同一レスポンス）
 *   - 503: Firestore 障害時
 *   - 情報漏洩防止: ownerId / ownerEmail / createdAt / updatedAt が含まれない
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockDocGet = vi.fn();

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: (_name: string) => ({
      doc: (_id: string) => ({
        get: () => mockDocGet(),
      }),
    }),
  }),
}));

async function buildApp() {
  const { publicRouter } = await import("../public.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v2/public", publicRouter);
  return app;
}

function makeSnapshot(data: Record<string, unknown> | null) {
  return {
    exists: data !== null,
    data: () => data,
  };
}

describe("GET /api/v2/public/tenants/:tenantId", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDocGet.mockReset();
  });

  describe("正常系 (AC-1, AC-5)", () => {
    it("active テナントで 200 + PublicTenantInfo を返す", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test Tenant",
          status: "active",
          gcipTenantId: "gcip-xyz",
          useGcip: true,
          ownerId: "uid-owner",
          ownerEmail: "owner@example.com",
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-02-01"),
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test-tenant");

      expect(res.status).toBe(200);
      expect(res.body.tenant).toEqual({
        id: "test-tenant",
        name: "Test Tenant",
        status: "active",
        gcipTenantId: "gcip-xyz",
        useGcip: true,
      });
    });

    it("suspended テナントでも 200 を返す（FE がメンテ画面切替判断に使用）", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Paused Tenant",
          status: "suspended",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/paused-tenant");

      expect(res.status).toBe(200);
      expect(res.body.tenant.status).toBe("suspended");
      expect(res.body.tenant.gcipTenantId).toBeNull();
      expect(res.body.tenant.useGcip).toBe(false);
    });

    it("gcipTenantId が未設定のテナント（非 GCIP 経路）でも 200 を返す", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Legacy Tenant",
          status: "active",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/legacy");

      expect(res.status).toBe(200);
      expect(res.body.tenant.gcipTenantId).toBeNull();
      expect(res.body.tenant.useGcip).toBe(false);
    });
  });

  describe("情報漏洩防止 (AC-2)", () => {
    it("レスポンスに ownerId / ownerEmail / createdAt / updatedAt / userCount が含まれない", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test",
          status: "active",
          gcipTenantId: null,
          useGcip: false,
          ownerId: "uid-owner",
          ownerEmail: "owner@example.com",
          userCount: 42,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      const tenantKeys = Object.keys(res.body.tenant).sort();
      expect(tenantKeys).toEqual(["gcipTenantId", "id", "name", "status", "useGcip"]);
    });
  });

  describe("404 系 (AC-3, AC-4)", () => {
    it("未登録 tenantId は 404 tenant_not_found", async () => {
      mockDocGet.mockResolvedValue(makeSnapshot(null));

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });

    it("RESERVED_TENANT_IDS (admin) は Firestore を呼ばず 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/admin");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("RESERVED_TENANT_IDS (super) も 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/super");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("RESERVED_TENANT_IDS (public) も 404（URL prefix と同名の回避）", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/public");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("不正フォーマット (大文字混入) は Firestore を呼ばず 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/BadCase");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("不正フォーマット (記号混入) は Firestore を呼ばず 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/invalid%20id");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("snapshot が存在するがデータが undefined の場合も 404", async () => {
      mockDocGet.mockResolvedValue({ exists: true, data: () => undefined });

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/stale");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });
  });

  describe("503 系 (AC-7)", () => {
    it("Firestore が throw した場合 503 firestore_unavailable", async () => {
      mockDocGet.mockRejectedValue(new Error("firestore timeout"));

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("firestore_unavailable");
    });

    it("503 時は Cache-Control: no-store を付与（障害回復後に古い応答を返さない）", async () => {
      mockDocGet.mockRejectedValue(new Error("firestore timeout"));

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
    });
  });

  describe("データ正規化（fail-closed）", () => {
    it("status が不正値の場合は suspended にフェイルクローズ（active 漏洩防止）", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test",
          status: "unknown_status",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.body.tenant.status).toBe("suspended");
    });

    it("status が欠落している場合も suspended にフェイルクローズ", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.body.tenant.status).toBe("suspended");
    });

    it("gcipTenantId が非 string の場合は null（parseTenantGcipFields 経由）", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test",
          status: "active",
          gcipTenantId: 12345,
          useGcip: true,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.body.tenant.gcipTenantId).toBeNull();
    });

    it("name が欠落している場合は空文字列にフォールバック（data 破損可視化のため warn）", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          status: "active",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.body.tenant.name).toBe("");
    });

    it("name が非 string の場合も空文字列にフォールバック", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: 42,
          status: "active",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.body.tenant.name).toBe("");
    });

    it("useGcip が truthy だが非 boolean の場合は false", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test",
          status: "active",
          gcipTenantId: "gcip-x",
          useGcip: "true",
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.body.tenant.useGcip).toBe(false);
    });
  });

  describe("HTTP キャッシュヘッダ", () => {
    it("成功時は Cache-Control: public, max-age=60, stale-while-revalidate=300 を付与", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Test",
          status: "active",
          gcipTenantId: null,
          useGcip: false,
        })
      );

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe(
        "public, max-age=60, stale-while-revalidate=300"
      );
    });

    it("404 時は Cache-Control: public, max-age=30 を付与（enumeration 攻撃時の Firestore read 抑制）", async () => {
      mockDocGet.mockResolvedValue(makeSnapshot(null));

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/nonexistent");

      expect(res.status).toBe(404);
      expect(res.headers["cache-control"]).toBe("public, max-age=30");
    });

    it("RESERVED_TENANT_IDS の 404 にも Cache-Control を付与", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/admin");

      expect(res.status).toBe(404);
      expect(res.headers["cache-control"]).toBe("public, max-age=30");
    });
  });
});
