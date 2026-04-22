/**
 * Issue #292: super-admin 経路の認証拒否ログ構造化テスト
 *
 * 各 403/401 分岐で logger.warn / logger.error が適切な reason / firebaseErrorCode で呼ばれ、
 * platform_auth_error_logs（InMemoryDataSource 差し替え）に記録されることを検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

vi.mock("firebase-admin/app", () => ({
  getApps: () => [{ name: "[DEFAULT]" }],
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: () => ({ get: async () => ({ docs: [] }) }),
  }),
}));

async function buildHarness(mode: "firebase" | "dev") {
  vi.stubEnv("AUTH_MODE", mode);
  vi.stubEnv("SUPER_ADMIN_EMAILS", "super@example.com");

  const { superAdminAuthMiddleware } = await import("../super-admin.js");
  const { setPlatformDataSourceForTest } = await import("../platform-datasource.js");

  const createPlatformAuthErrorLog = vi.fn().mockResolvedValue({ id: "p1" });
  // 最小限の DataSource スタブ（createPlatformAuthErrorLog のみ検証）
  setPlatformDataSourceForTest({
    createPlatformAuthErrorLog,
  } as never);

  const app = express();
  app.use(express.json());
  app.use(superAdminAuthMiddleware);
  app.get("/me", (req, res) => {
    res.json({ superAdmin: req.superAdmin ?? null });
  });

  return { app, createPlatformAuthErrorLog };
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-x",
    email_verified: true,
    firebase: { sign_in_provider: "google.com" },
    email: "user@example.com",
    ...overrides,
  };
}

describe("superAdminAuthMiddleware — Issue #292 structured denial logging", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    mockVerifyIdToken.mockReset();
    // resetModules 後の実装側 logger と同じインスタンスを取得して spy する
    const { logger } = await import("../../utils/logger.js");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    const { setPlatformDataSourceForTest } = await import("../platform-datasource.js");
    setPlatformDataSourceForTest(null);
  });

  describe("firebase mode", () => {
    it("no_auth_header: Authorization 欠落で 401 + logger.warn + platform_auth_error_logs", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("firebase");

      const res = await supertest(app).get("/me");
      expect(res.status).toBe(401);

      expect(warnSpy).toHaveBeenCalledWith(
        "Super admin access denied",
        expect.objectContaining({
          errorType: "super_admin_denied",
          reason: "no_auth_header",
        })
      );
      expect(createPlatformAuthErrorLog).toHaveBeenCalledTimes(1);
      expect(createPlatformAuthErrorLog.mock.calls[0][0]).toMatchObject({
        errorType: "super_admin_denied",
        reason: "no_auth_header",
        tenantId: "__platform__",
        firebaseErrorCode: null,
      });
    });

    it("email_not_verified: email_verified=false → 403 + reason=email_not_verified", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("firebase");
      mockVerifyIdToken.mockResolvedValue(
        makeToken({ email_verified: false, email: "unverified@example.com" })
      );

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(403);

      expect(warnSpy).toHaveBeenCalledWith(
        "Super admin access denied",
        expect.objectContaining({
          errorType: "super_admin_denied",
          reason: "email_not_verified",
          email: "unverified@example.com",
        })
      );
      expect(createPlatformAuthErrorLog.mock.calls[0][0].reason).toBe("email_not_verified");
    });

    it("non_google_provider: sign_in_provider=password → reason=non_google_provider", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("firebase");
      mockVerifyIdToken.mockResolvedValue(
        makeToken({ firebase: { sign_in_provider: "password" } })
      );

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(403);

      expect(createPlatformAuthErrorLog.mock.calls[0][0].reason).toBe("non_google_provider");
    });

    it("email_missing: email 欠損 → reason=email_missing", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("firebase");
      mockVerifyIdToken.mockResolvedValue(makeToken({ email: undefined }));

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(403);

      expect(createPlatformAuthErrorLog.mock.calls[0][0].reason).toBe("email_missing");
    });

    it("not_super_admin: 検証済みメールだが super admin 登録なし → reason=not_super_admin", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("firebase");
      mockVerifyIdToken.mockResolvedValue(makeToken({ email: "nobody@example.com" }));

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(403);

      expect(createPlatformAuthErrorLog.mock.calls[0][0].reason).toBe("not_super_admin");
      expect(createPlatformAuthErrorLog.mock.calls[0][0].email).toBe("nobody@example.com");
    });

    it("catch 節: verifyIdToken 失敗 → logger.error + firebaseErrorCode", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("firebase");
      const err = Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" });
      mockVerifyIdToken.mockRejectedValue(err);

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(401);

      expect(errorSpy).toHaveBeenCalledWith(
        "Super admin token verification failed",
        expect.objectContaining({
          errorType: "super_admin_token_error",
          firebaseErrorCode: "auth/id-token-revoked",
        })
      );
      expect(createPlatformAuthErrorLog.mock.calls[0][0]).toMatchObject({
        errorType: "super_admin_token_error",
        firebaseErrorCode: "auth/id-token-revoked",
        reason: null,
      });
    });
  });

  describe("dev mode", () => {
    it("no_auth_header: X-User-Email 欠落で 401 + reason=no_auth_header", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("dev");

      const res = await supertest(app).get("/me");
      expect(res.status).toBe(401);

      expect(createPlatformAuthErrorLog.mock.calls[0][0].reason).toBe("no_auth_header");
    });

    it("not_super_admin: 登録されていないメール → 403 + reason=not_super_admin", async () => {
      const { app, createPlatformAuthErrorLog } = await buildHarness("dev");

      const res = await supertest(app).get("/me").set("x-user-email", "nobody@example.com");
      expect(res.status).toBe(403);

      expect(createPlatformAuthErrorLog.mock.calls[0][0]).toMatchObject({
        errorType: "super_admin_denied",
        reason: "not_super_admin",
        email: "nobody@example.com",
      });
    });
  });
});
