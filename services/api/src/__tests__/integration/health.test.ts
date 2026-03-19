/**
 * ヘルスチェックエンドポイントのテスト
 */

import { describe, it, expect } from "vitest";
import supertest from "supertest";
import app from "../../index.js";

describe("Health endpoints", () => {
  const request = supertest(app);

  describe("GET /health", () => {
    it("200とstatus:okを返す", async () => {
      const res = await request.get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /healthz", () => {
    it("200とstatus:okを返す", async () => {
      const res = await request.get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /api/health", () => {
    it("200とstatus:okを返す", async () => {
      const res = await request.get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /health/ready", () => {
    it("checksオブジェクトとmemory情報を返す", async () => {
      const res = await request.get("/health/ready");
      // GCP認証なし環境では200（firestoreはskipped）
      expect([200, 503]).toContain(res.status);
      expect(res.body.checks).toBeDefined();
      expect(res.body.checks.memory).toBeDefined();
      expect(typeof res.body.checks.memory.heapUsedMB).toBe("number");
      expect(typeof res.body.checks.memory.heapTotalMB).toBe("number");
      expect(typeof res.body.checks.memory.rssMB).toBe("number");
    });

    it("GCP認証なし環境ではfirestore=skippedを返す", async () => {
      // テスト環境ではGCP認証環境変数なし
      const res = await request.get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.checks.firestore).toBe("skipped");
    });
  });
});
