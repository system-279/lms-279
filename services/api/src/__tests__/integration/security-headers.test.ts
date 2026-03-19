/**
 * セキュリティヘッダのテスト
 *
 * Helmet + rate limiter のミドルウェア順序・動作確認
 */

import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

/**
 * index.tsと同じミドルウェア順序を再現した独立アプリ
 * 共有app（index.ts）のrate limiterステートに影響されない
 */
function createSecurityTestApp() {
  const app = express();

  app.use(helmet());

  // ヘルスチェック（rate limiterの前）
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // rate limiter（ヘルスチェックの後）
  app.use(rateLimit({ windowMs: 60_000, limit: 3, legacyHeaders: false }));

  // 通常エンドポイント（rate limiter対象）
  app.get("/api/test", (_req, res) => res.json({ ok: true }));

  return app;
}

describe("Security headers (Helmet)", () => {
  it("X-Content-Type-Optionsがnosniffに設定されている", async () => {
    const request = supertest(createSecurityTestApp());
    const res = await request.get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("X-Frame-OptionsがSAMEORIGINに設定されている", async () => {
    const request = supertest(createSecurityTestApp());
    const res = await request.get("/health");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("X-Powered-Byヘッダが除去されている", async () => {
    const request = supertest(createSecurityTestApp());
    const res = await request.get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("Rate limiter ordering", () => {
  it("ヘルスチェックはrate limiter対象外", async () => {
    const app = createSecurityTestApp();
    const request = supertest(app);

    // limit=3で通常エンドポイントは4回目で429
    for (let i = 0; i < 3; i++) {
      await request.get("/api/test");
    }
    const blocked = await request.get("/api/test");
    expect(blocked.status).toBe(429);

    // 同じアプリで/healthは何度でも200
    const health = await request.get("/health");
    expect(health.status).toBe(200);
  });
});
