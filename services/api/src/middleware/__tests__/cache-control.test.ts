/**
 * Cache-Control ミドルウェアのテスト
 */

import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { privateCache } from "../cache-control.js";

describe("privateCache", () => {
  it("Cache-Controlヘッダにprivateとmax-ageを設定する", async () => {
    const app = express();
    app.get("/test", privateCache(60), (_req, res) => res.json({ ok: true }));
    const request = supertest(app);

    const res = await request.get("/test");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=60");
  });

  it("VaryヘッダにAuthorization, Cookieを設定する", async () => {
    const app = express();
    app.get("/test", privateCache(30), (_req, res) => res.json({ ok: true }));
    const request = supertest(app);

    const res = await request.get("/test");
    expect(res.headers["vary"]).toContain("Authorization");
    expect(res.headers["vary"]).toContain("Cookie");
  });

  it("max-ageに任意の秒数を設定できる", async () => {
    const app = express();
    app.get("/test", privateCache(300), (_req, res) => res.json({ ok: true }));
    const request = supertest(app);

    const res = await request.get("/test");
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
  });
});
