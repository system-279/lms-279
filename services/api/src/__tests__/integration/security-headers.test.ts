/**
 * セキュリティヘッダのテスト
 *
 * Helmet + rate limiter のミドルウェア順序・動作確認
 */

import { describe, it, expect } from "vitest";
import supertest from "supertest";
import app from "../../index.js";

describe("Security headers", () => {
  const request = supertest(app);

  it("X-Content-Type-Optionsがnosniffに設定されている", async () => {
    const res = await request.get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("X-Frame-OptionsがSAMEORIGINに設定されている", async () => {
    // Helmetのデフォルト
    const res = await request.get("/health");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("X-Powered-Byヘッダが除去されている", async () => {
    const res = await request.get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("Rate limiter ordering", () => {
  const request = supertest(app);

  it("ヘルスチェックはrate limiter対象外（何度呼んでも200）", async () => {
    // 150回呼んでも429にならないことを確認（globalLimiter: 100/min）
    for (let i = 0; i < 150; i++) {
      const res = await request.get("/health");
      expect(res.status).toBe(200);
    }
  });
});
