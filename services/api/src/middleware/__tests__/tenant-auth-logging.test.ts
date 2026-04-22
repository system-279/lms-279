/**
 * Issue #292: tenant-auth 経路の認証拒否ログ構造化テスト
 *
 * - TenantAccessDeniedError の reason が分岐ごとに期待値になっていること
 * - handleTenantAccessDenied が logger.warn + auth_error_logs に reason を記録すること
 * - catch 節で logger.error が firebaseErrorCode 付きで呼ばれること
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();
const mockIsSuperAdmin = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

vi.mock("firebase-admin/app", () => ({
  getApps: () => [{ name: "[DEFAULT]" }],
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));

vi.mock("../super-admin.js", () => ({
  isSuperAdmin: (email?: string) => mockIsSuperAdmin(email),
}));

async function buildApp() {
  vi.stubEnv("AUTH_MODE", "firebase");
  const { tenantAwareAuthMiddleware } = await import("../tenant-auth.js");
  const { InMemoryDataSource } = await import("../../datasource/in-memory.js");

  const ds = new InMemoryDataSource({ readOnly: false });
  const createAuthErrorLogSpy = vi.spyOn(ds, "createAuthErrorLog");

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

  return { app, ds, createAuthErrorLogSpy };
}

describe("tenantAwareAuthMiddleware — Issue #292 structured denial logging", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    mockVerifyIdToken.mockReset();
    mockIsSuperAdmin.mockReset().mockResolvedValue(false);
    // resetModules 後の実装側 logger と同じインスタンスを取得して spy する
    const { logger } = await import("../../utils/logger.js");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("email_verified=false → reason=email_not_verified が logger/auth_error_logs に記録", async () => {
    const { app, createAuthErrorLogSpy } = await buildApp();
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-1",
      email: "unverified@example.com",
      email_verified: false,
      firebase: { sign_in_provider: "google.com" },
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
    expect(res.status).toBe(403);

    expect(warnSpy).toHaveBeenCalledWith(
      "Tenant access denied",
      expect.objectContaining({
        errorType: "tenant_access_denied",
        reason: "email_not_verified",
      })
    );
    expect(createAuthErrorLogSpy.mock.calls[0][0]).toMatchObject({
      errorType: "tenant_access_denied",
      reason: "email_not_verified",
      firebaseErrorCode: null,
    });
  });

  it("sign_in_provider=password → reason=non_google_provider", async () => {
    const { app, createAuthErrorLogSpy } = await buildApp();
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-2",
      email: "pw@example.com",
      email_verified: true,
      firebase: { sign_in_provider: "password" },
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
    expect(res.status).toBe(403);
    expect(createAuthErrorLogSpy.mock.calls[0][0].reason).toBe("non_google_provider");
  });

  it("allowlist 不在 → reason=not_in_allowlist", async () => {
    const { app, createAuthErrorLogSpy } = await buildApp();
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-3",
      email: "new@example.com",
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    // allowed_emails 未登録 + 既存ユーザーなし → 新規作成パスで 403

    const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
    expect(res.status).toBe(403);
    expect(createAuthErrorLogSpy.mock.calls[0][0].reason).toBe("not_in_allowlist");
  });

  it("email 欠損 + 既存ユーザー有 → reason=email_missing", async () => {
    const { app, ds, createAuthErrorLogSpy } = await buildApp();
    // 既存 user は存在するが decodedToken に email がない
    await ds.createUser({
      email: "",
      name: "NoEmail",
      role: "student",
      firebaseUid: "uid-4",
    });
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-4",
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
    expect(res.status).toBe(403);
    expect(createAuthErrorLogSpy.mock.calls[0][0].reason).toBe("email_missing");
  });

  it("catch 節: verifyIdToken 失敗 → logger.error + firebaseErrorCode", async () => {
    const { app } = await buildApp();
    const err = Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" });
    mockVerifyIdToken.mockRejectedValue(err);

    await supertest(app).get("/me").set("authorization", "Bearer tok");

    expect(errorSpy).toHaveBeenCalledWith(
      "Tenant token verification failed",
      expect.objectContaining({
        errorType: "tenant_token_error",
        firebaseErrorCode: "auth/id-token-revoked",
      })
    );
  });
});
