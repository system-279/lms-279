/**
 * 予約済みテナントID（_master等）へのアクセス制限テスト
 */

import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";
import express from "express";
import { tenantMiddleware } from "../../middleware/tenant.js";

vi.mock("../../datasource/index.js", () => ({
  getDataSource: vi.fn(() => ({})),
}));

function createApp() {
  const app = express();
  // テナントパスをマウント
  app.get("/api/v2/:tenant/test", tenantMiddleware, (_req, res) => {
    res.json({ ok: true, tenantId: _req.tenantContext?.tenantId });
  });
  return app;
}

describe("予約済みテナントIDアクセス制限", () => {
  const request = supertest(createApp());

  it("_master テナントへのアクセスが403で拒否される", async () => {
    const res = await request.get("/api/v2/_master/test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("reserved_tenant");
  });

  it("通常のテナントIDは正常にアクセスできる", async () => {
    const res = await request.get("/api/v2/my-tenant/test");
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe("my-tenant");
  });

  it("不正なテナントIDは400で拒否される", async () => {
    const res = await request.get("/api/v2/invalid%20id/test");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_tenant_id");
  });
});
