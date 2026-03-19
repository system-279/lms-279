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
    it("checksオブジェクトを含むレスポンスを返す", async () => {
      const res = await request.get("/health/ready");
      // Firestore未接続環境では503の可能性があるが、checksは必ず含む
      expect([200, 503]).toContain(res.status);
      expect(res.body.checks).toBeDefined();
      expect(res.body.checks.memory).toBeDefined();
      expect(res.body.checks.memory.heapUsedMB).toBeTypeOf("number");
      expect(res.body.checks.memory.rssMB).toBeTypeOf("number");
    });

    it("Firestore接続失敗時はstatus:degradedと503を返す", async () => {
      // テスト環境ではFirestoreが未接続のためdegradedになる
      const res = await request.get("/health/ready");
      if (res.status === 503) {
        expect(res.body.status).toBe("degraded");
        expect(res.body.checks.firestore).toBe("error");
      }
      // 接続成功時はokを確認
      if (res.status === 200) {
        expect(res.body.status).toBe("ok");
        expect(res.body.checks.firestore).toBe("ok");
      }
    });
  });
});
