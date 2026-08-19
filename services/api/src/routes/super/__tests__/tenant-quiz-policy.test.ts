/**
 * createTenantQuizPolicyRouter (Stage 2 GET/PUT /super/tenants/:id/quiz-policy)。
 *
 * - GET: 未設定 200 既定値 / 設定済み 200 / tenant_not_found 404 / 不正 tenantId 404
 * - PUT: ラウンドトリップ / 明示 false での上書き / master OFF 時のサブ設定保持 /
 *        非 boolean・null・欠損 → 400 / 存在しない tenant → 404
 *
 * Firestore I/O は InMemoryDataSource を deps.getDataSource として inject（fake）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  createTenantQuizPolicyRouter,
  type TenantQuizPolicyRouteDeps,
} from "../tenant-quiz-policy.js";
import { InMemoryDataSource } from "../../../datasource/in-memory.js";

function makeApp(deps: TenantQuizPolicyRouteDeps) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { superAdmin?: { email: string } }).superAdmin = {
      email: "admin@example.com",
    };
    next();
  });
  app.use("/api/v2/super", createTenantQuizPolicyRouter(deps));
  return app;
}

describe("tenant-quiz-policy route", () => {
  let ds: InMemoryDataSource;
  let existingTenants: Set<string>;
  let deps: TenantQuizPolicyRouteDeps;

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
    existingTenants = new Set(["acme"]);
    deps = {
      tenantExists: async (tenantId) => existingTenants.has(tenantId),
      getDataSource: () => ds,
    };
  });

  describe("GET /tenants/:tenantId/quiz-policy", () => {
    it("未設定テナントは 200 + 既定値（両方 false、updatedBy/updatedAt は null）を返す", async () => {
      const app = makeApp(deps);
      const res = await request(app).get("/api/v2/super/tenants/acme/quiz-policy");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        quizSkipEnabled: false,
        pdfDownloadAllowedForSkipped: false,
        updatedBy: null,
        updatedAt: null,
      });
    });

    it("設定済みテナントは保存値を返す", async () => {
      await ds.upsertTenantQuizPolicy({
        quizSkipEnabled: true,
        pdfDownloadAllowedForSkipped: true,
        updatedBy: "admin@example.com",
      });
      const app = makeApp(deps);
      const res = await request(app).get("/api/v2/super/tenants/acme/quiz-policy");

      expect(res.status).toBe(200);
      expect(res.body.quizSkipEnabled).toBe(true);
      expect(res.body.pdfDownloadAllowedForSkipped).toBe(true);
      expect(res.body.updatedBy).toBe("admin@example.com");
    });

    it("存在しないテナントは 404 tenant_not_found", async () => {
      const app = makeApp(deps);
      const res = await request(app).get("/api/v2/super/tenants/unknown/quiz-policy");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });

    it("不正な形式の tenantId は 404 tenant_not_found", async () => {
      const app = makeApp(deps);
      const res = await request(app).get("/api/v2/super/tenants/bad%2Fid/quiz-policy");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });
  });

  describe("PUT /tenants/:tenantId/quiz-policy", () => {
    it("PUT した値が直後の GET で返る（ラウンドトリップ）", async () => {
      const app = makeApp(deps);
      const putRes = await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: true, pdfDownloadAllowedForSkipped: false });

      expect(putRes.status).toBe(200);
      expect(putRes.body.quizSkipEnabled).toBe(true);
      expect(putRes.body.pdfDownloadAllowedForSkipped).toBe(false);
      expect(putRes.body.updatedBy).toBe("admin@example.com");
      expect(typeof putRes.body.updatedAt).toBe("string");

      const getRes = await request(app).get("/api/v2/super/tenants/acme/quiz-policy");
      expect(getRes.body.quizSkipEnabled).toBe(true);
      expect(getRes.body.pdfDownloadAllowedForSkipped).toBe(false);
    });

    it("明示的な false が既存の true を上書きする（truthy 誤変換の回帰ガード）", async () => {
      const app = makeApp(deps);
      await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: true, pdfDownloadAllowedForSkipped: true });

      const res = await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: false, pdfDownloadAllowedForSkipped: false });

      expect(res.status).toBe(200);
      expect(res.body.quizSkipEnabled).toBe(false);
      expect(res.body.pdfDownloadAllowedForSkipped).toBe(false);
    });

    it("quizSkipEnabled=false かつ pdfDownloadAllowedForSkipped=true の組み合わせをエラーにせずそのまま保存する（master OFF 時のサブ設定保持、設計判断5）", async () => {
      const app = makeApp(deps);
      const res = await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: false, pdfDownloadAllowedForSkipped: true });

      expect(res.status).toBe(200);
      expect(res.body.quizSkipEnabled).toBe(false);
      expect(res.body.pdfDownloadAllowedForSkipped).toBe(true);
    });

    it("quizSkipEnabled が非 boolean のとき 400 bad_request", async () => {
      const app = makeApp(deps);
      const res = await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: "true", pdfDownloadAllowedForSkipped: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    });

    it("quizSkipEnabled が null のとき 400 bad_request（undefined とは別に検証）", async () => {
      const app = makeApp(deps);
      const res = await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: null, pdfDownloadAllowedForSkipped: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    });

    it("pdfDownloadAllowedForSkipped が欠損しているとき 400 bad_request", async () => {
      const app = makeApp(deps);
      const res = await request(app)
        .put("/api/v2/super/tenants/acme/quiz-policy")
        .send({ quizSkipEnabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    });

    it("存在しないテナントへの PUT は 404 tenant_not_found", async () => {
      const app = makeApp(deps);
      const res = await request(app)
        .put("/api/v2/super/tenants/unknown/quiz-policy")
        .send({ quizSkipEnabled: true, pdfDownloadAllowedForSkipped: true });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });
  });
});
