/**
 * GET /api/v2/help/role (routes/help-role.ts) 統合テスト
 *
 * 確認対象:
 *   - Issue #294 / ADR-031: `verifyIdToken` 直接呼び出し経路への境界統一
 *     - checkRevoked=true で revoke 後のトークンを拒否（student フォールバック）
 *     - email_verified=true 必須
 *     - sign_in_provider=google.com 必須
 *     - 不適合時は super/admin 昇格させず "student" レベルを返す
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();
const mockIsSuperAdmin = vi.fn();
const mockGetFirestore = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => mockGetFirestore(),
}));

vi.mock("../../middleware/super-admin.js", () => ({
  isSuperAdmin: mockIsSuperAdmin,
}));

function makeDecodedToken(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-default",
    email: "user@example.com",
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
}

/** Firestore `tenants` 走査を空コレクションでモック（student フォールバック経路を確実化）。 */
function mockEmptyTenants() {
  mockGetFirestore.mockReturnValue({
    collection: () => ({
      get: vi.fn().mockResolvedValue({ docs: [] }),
    }),
  });
}

async function buildApp() {
  const { helpRoleRouter } = await import("../help-role.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v2/help", helpRoleRouter);
  return app;
}

describe("GET /api/v2/help/role — firebase mode (Issue #294)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    mockVerifyIdToken.mockReset();
    mockIsSuperAdmin.mockReset();
    mockGetFirestore.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Bearer トークン欠落時は student を返す（既存挙動）", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/api/v2/help/role");
    expect(res.status).toBe(200);
    expect(res.body.helpLevel).toBe("student");
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("verifyIdToken は checkRevoked=true で呼ばれる", async () => {
    mockVerifyIdToken.mockResolvedValue(makeDecodedToken());
    mockIsSuperAdmin.mockResolvedValue(false);
    mockEmptyTenants();
    const app = await buildApp();

    await supertest(app)
      .get("/api/v2/help/role")
      .set("authorization", "Bearer id-token-xyz");

    expect(mockVerifyIdToken).toHaveBeenCalledWith("id-token-xyz", true);
  });

  it("email_verified=false なら student にフォールバック（super/admin 昇格を拒否）", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email_verified: false })
    );
    // 万が一呼ばれても super を返さないように明示しておく
    mockIsSuperAdmin.mockResolvedValue(true);
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/help/role")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.helpLevel).toBe("student");
    expect(mockIsSuperAdmin).not.toHaveBeenCalled();
  });

  it("email_verified が undefined（欠落）なら student にフォールバック", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-missing-verified",
      email: "user@example.com",
      firebase: { sign_in_provider: "google.com", identities: {} },
      // email_verified フィールドなし
    });
    mockIsSuperAdmin.mockResolvedValue(true);
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/help/role")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.helpLevel).toBe("student");
    expect(mockIsSuperAdmin).not.toHaveBeenCalled();
  });

  it("sign_in_provider=password なら student にフォールバック", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );
    mockIsSuperAdmin.mockResolvedValue(true);
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/help/role")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.helpLevel).toBe("student");
    expect(mockIsSuperAdmin).not.toHaveBeenCalled();
  });

  it("decodedToken.firebase が undefined でも student にフォールバック（fail-closed）", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-no-firebase",
      email: "user@example.com",
      email_verified: true,
      // firebase フィールドなし（SDK 形状差対策）
    });
    mockIsSuperAdmin.mockResolvedValue(true);
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/help/role")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.helpLevel).toBe("student");
    expect(mockIsSuperAdmin).not.toHaveBeenCalled();
  });

  it("email_verified=true + sign_in_provider=google.com + スーパー管理者 → super", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email: "super@example.com" })
    );
    mockIsSuperAdmin.mockResolvedValue(true);
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/help/role")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.helpLevel).toBe("super");
  });
});
