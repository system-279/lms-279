/**
 * GET /api/v2/public/tenants/:tenantId (routes/public.ts) の統合テスト
 *
 * 認証不要の公開テナント情報 endpoint（ADR-031）。
 *
 * 検証対象:
 *   - 正常系: active / suspended の両方で 200 を返す
 *   - 404: 未登録 / RESERVED_TENANT_IDS / 不正フォーマット全経路が
 *     body / headers 完全一致（enumeration 防止の回帰防止）
 *   - 503: Firestore 障害時に logger.error + Cache-Control: no-store
 *   - 情報漏洩防止: 応答は id / status / gcipTenantId / useGcip のみ
 *   - 観測性: status / name / 503 path で logger.warn/error が発火する契約
 *   - Wiring: authLimiter が publicRouter の前段に mount されている
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

  describe("正常系", () => {
    it("active テナントで 200 + id/status/gcipTenantId/useGcip を返す", async () => {
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
        status: "active",
        gcipTenantId: "gcip-xyz",
        useGcip: true,
      });
    });

    it("suspended テナントでも 200 を返す（FE がメンテ画面切替判断に使用）", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
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

  describe("情報漏洩防止", () => {
    it("応答に name / ownerId / ownerEmail / createdAt / updatedAt / userCount が含まれない", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
          name: "Corporate Acme",
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
      expect(Object.keys(res.body).sort()).toEqual(["tenant"]);
      expect(Object.keys(res.body.tenant).sort()).toEqual([
        "gcipTenantId",
        "id",
        "status",
        "useGcip",
      ]);
    });
  });

  describe("404 経路の完全等価性（enumeration 防止）", () => {
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
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("RESERVED_TENANT_IDS (super) も 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/super");

      expect(res.status).toBe(404);
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("RESERVED_TENANT_IDS (public) も 404（URL prefix と同名の回避）", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/public");

      expect(res.status).toBe(404);
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("不正フォーマット (大文字混入) は Firestore を呼ばず 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/BadCase");

      expect(res.status).toBe(404);
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("不正フォーマット (記号混入) は Firestore を呼ばず 404", async () => {
      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/invalid%20id");

      expect(res.status).toBe(404);
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it("snapshot が存在するがデータが undefined の場合も 404", async () => {
      mockDocGet.mockResolvedValue({ exists: true, data: () => undefined });

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/stale");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });

    it("全 404 経路で body / Cache-Control / status が完全一致（enumeration 防止の回帰防止）", async () => {
      const app = await buildApp();

      mockDocGet.mockResolvedValue(makeSnapshot(null));
      const notFound = await supertest(app).get("/api/v2/public/tenants/nonexistent");

      mockDocGet.mockReset();
      const reserved = await supertest(app).get("/api/v2/public/tenants/admin");

      mockDocGet.mockReset();
      const badFormat = await supertest(app).get("/api/v2/public/tenants/BadCase");

      mockDocGet.mockReset();
      mockDocGet.mockResolvedValueOnce({ exists: true, data: () => undefined });
      const staleDoc = await supertest(app).get("/api/v2/public/tenants/stale");

      for (const other of [reserved, badFormat, staleDoc]) {
        expect(other.status).toBe(notFound.status);
        expect(other.body).toEqual(notFound.body);
        expect(other.headers["cache-control"]).toBe(notFound.headers["cache-control"]);
      }
    });
  });

  describe("503 系", () => {
    it("Firestore が throw した場合 503 firestore_unavailable + Cache-Control: no-store", async () => {
      mockDocGet.mockRejectedValue(new Error("firestore timeout"));

      const app = await buildApp();
      const res = await supertest(app).get("/api/v2/public/tenants/test");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("firestore_unavailable");
      expect(res.headers["cache-control"]).toBe("no-store");
    });
  });

  describe("データ正規化（fail-closed）", () => {
    it("status が不正値の場合は suspended にフェイルクローズ（active 漏洩防止）", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
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

    it("useGcip が truthy だが非 boolean の場合は false", async () => {
      mockDocGet.mockResolvedValue(
        makeSnapshot({
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
    it("200 / 404 の Cache-Control が同一（public, max-age=60）", async () => {
      const app = await buildApp();

      mockDocGet.mockResolvedValue(
        makeSnapshot({
          status: "active",
          gcipTenantId: null,
          useGcip: false,
        })
      );
      const found = await supertest(app).get("/api/v2/public/tenants/found");

      mockDocGet.mockReset();
      mockDocGet.mockResolvedValue(makeSnapshot(null));
      const notFound = await supertest(app).get("/api/v2/public/tenants/missing");

      expect(found.headers["cache-control"]).toBe("public, max-age=60");
      expect(notFound.headers["cache-control"]).toBe("public, max-age=60");
    });
  });

  describe("観測性（logger 契約）", () => {
    it("status 不正値で logger.warn が errorType=tenant_status_invalid で呼ばれる", async () => {
      const { logger } = await import("../../utils/logger.js");
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      mockDocGet.mockResolvedValue(
        makeSnapshot({ status: "bogus", gcipTenantId: null, useGcip: false })
      );

      const app = await buildApp();
      await supertest(app).get("/api/v2/public/tenants/test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("status"),
        expect.objectContaining({
          errorType: "tenant_status_invalid",
          tenantId: "test",
          actualValue: "bogus",
        })
      );
      warnSpy.mockRestore();
    });

    it("503 経路で logger.error が firestoreErrorCode 付きで呼ばれる", async () => {
      const { logger } = await import("../../utils/logger.js");
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

      const firestoreErr = Object.assign(new Error("IAM"), { code: "permission-denied" });
      mockDocGet.mockRejectedValue(firestoreErr);

      const app = await buildApp();
      await supertest(app).get("/api/v2/public/tenants/test");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Firestore"),
        expect.objectContaining({
          errorType: "public_tenant_firestore_error",
          tenantId: "test",
          firestoreErrorCode: "permission-denied",
        })
      );
      errorSpy.mockRestore();
    });
  });

  describe("Wiring (authLimiter が mount されている)", () => {
    it("authLimiter 配下では 11 リクエスト目で 429 を返す", async () => {
      // 実際の index.ts と同じ middleware 順序を再現して実挙動で wiring を確認する。
      const { authLimiter } = await import("../../middleware/rate-limiter.js");
      const { publicRouter } = await import("../public.js");
      const app = express();
      app.use(express.json());
      app.use("/api/v2/public", authLimiter, publicRouter);

      mockDocGet.mockResolvedValue(
        makeSnapshot({ status: "active", gcipTenantId: null, useGcip: false })
      );

      const agent = supertest.agent(app);
      for (let i = 0; i < 10; i++) {
        const ok = await agent.get("/api/v2/public/tenants/test");
        expect(ok.status).toBe(200);
      }

      const overflow = await agent.get("/api/v2/public/tenants/test");
      expect(overflow.status).toBe(429);
    });
  });
});
