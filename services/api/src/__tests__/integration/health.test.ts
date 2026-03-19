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
    it("GCP認証なし環境では200・firestore=skipped・memory情報を返す", async () => {
      const res = await request.get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.checks.firestore).toBe("skipped");
      expect(typeof res.body.checks.memory.heapUsedMB).toBe("number");
      expect(typeof res.body.checks.memory.heapTotalMB).toBe("number");
      expect(typeof res.body.checks.memory.rssMB).toBe("number");
    });
  });
});
