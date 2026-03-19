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

  // /health/ready はFirestore接続を試みるためCI環境ではタイムアウトする。
  // Firestore接続テストはE2E（ローカル環境）で検証する。
});
