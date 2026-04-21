/**
 * CG-1: tenantAwareAuthMiddleware (AUTH_MODE=firebase) の email 正規化検証
 *
 * findOrCreateTenantUser に渡る email が decodedToken から trim().toLowerCase()
 * されていることを実経路で確認する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

vi.mock("firebase-admin/app", () => ({
  getApps: () => [{ name: "[DEFAULT]" }],
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));

vi.mock("../super-admin.js", () => ({
  isSuperAdmin: vi.fn().mockResolvedValue(false),
}));

async function buildApp() {
  const { tenantAwareAuthMiddleware } = await import("../tenant-auth.js");
  const { InMemoryDataSource } = await import("../../datasource/in-memory.js");

  const ds = new InMemoryDataSource({ readOnly: false });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantContext = { tenantId: "t1", isDemo: false };
    req.dataSource = ds;
    next();
  });
  app.use(tenantAwareAuthMiddleware);
  app.get("/me", (req, res) => {
    res.json({ user: req.user ?? null });
  });

  return { app, ds };
}

describe("tenantAwareAuthMiddleware (firebase mode) — email normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    mockVerifyIdToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("前後空白と大文字を含む decodedToken.email を正規化して allowlist チェックに通す", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "case-insensitive@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-abc",
      email: "  CASE-Insensitive@Example.COM  ",
      name: "CI User",
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.email).toBe("case-insensitive@example.com");
  });

  it("decodedToken.email 不在でも allowed_emails に該当しないため 403", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-no-email",
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
  });

  it("verifyIdToken は checkRevoked=true で呼ばれる（H-A: revoke後の即時失効）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-check",
      email: "check@example.com",
    });

    await supertest(app).get("/me").set("authorization", "Bearer idToken-xyz");

    expect(mockVerifyIdToken).toHaveBeenCalledWith("idToken-xyz", true);
  });
});
