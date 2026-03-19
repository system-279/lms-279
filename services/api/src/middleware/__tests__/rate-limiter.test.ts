/**
 * レート制限ミドルウェアのテスト
 */

import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { globalLimiter, authLimiter } from "../rate-limiter.js";

function createApp(limiter: ReturnType<typeof import("express-rate-limit").default>) {
  const app = express();
  app.use(limiter);
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("globalLimiter", () => {
  it("100リクエスト以内は200を返す", async () => {
    const app = createApp(globalLimiter);
    const request = supertest(app);

    const res = await request.get("/test");
    expect(res.status).toBe(200);
  });

  it("101リクエスト目で429を返す", async () => {
    const app = createApp(globalLimiter);
    const request = supertest(app);

    // 100リクエスト送信
    for (let i = 0; i < 100; i++) {
      await request.get("/test");
    }

    // 101リクエスト目
    const res = await request.get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

describe("authLimiter", () => {
  it("10リクエスト以内は200を返す", async () => {
    const app = createApp(authLimiter);
    const request = supertest(app);

    const res = await request.get("/test");
    expect(res.status).toBe(200);
  });

  it("11リクエスト目で429を返す", async () => {
    const app = createApp(authLimiter);
    const request = supertest(app);

    // 10リクエスト送信
    for (let i = 0; i < 10; i++) {
      await request.get("/test");
    }

    // 11リクエスト目
    const res = await request.get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("429レスポンスにRateLimit-Policyヘッダが含まれる", async () => {
    const app = createApp(authLimiter);
    const request = supertest(app);

    for (let i = 0; i < 10; i++) {
      await request.get("/test");
    }

    const res = await request.get("/test");
    expect(res.status).toBe(429);
    // draft-7 standard headers
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});
