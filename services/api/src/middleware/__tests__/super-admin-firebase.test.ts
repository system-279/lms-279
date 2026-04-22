/**
 * superAdminAuthMiddleware (AUTH_MODE=firebase) 統合テスト (Issue #289)
 *
 * tenantAwareAuthMiddleware の Issue #286 ガード（email_verified / sign_in_provider）と
 * checkRevoked=true を super-admin 経路にも適用する。背景:
 *   - Codex セカンドオピニオン (PR #288 P1) + pr-test-analyzer C2 指摘
 *   - super-admin は全テナント横断で admin 権限を持つため、バイパスが成立した場合の影響が最大
 *   - ADR-031「allowed_emails 境界の必須条件 #1, #2」を両経路で徹底
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

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: () => ({
      get: async () => ({ docs: [] }),
    }),
  }),
}));

/**
 * Google プロバイダ + 検証済みメールの標準 decodedToken を生成するヘルパー。
 * Issue #289 で新規に必須化される `email_verified` / `firebase.sign_in_provider` を
 * デフォルト有効化し、失敗系テストは明示的に override する。
 */
function makeDecodedToken(overrides: Record<string, unknown> = {}) {
  return {
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
}

async function buildApp() {
  const { superAdminAuthMiddleware } = await import("../super-admin.js");

  const app = express();
  app.use(express.json());
  app.use(superAdminAuthMiddleware);
  app.get("/me", (req, res) => {
    res.json({ superAdmin: req.superAdmin ?? null });
  });

  return { app };
}

describe("superAdminAuthMiddleware (firebase mode) — Issue #289: email_verified / sign_in_provider / checkRevoked", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "super@example.com");
    mockVerifyIdToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("正常系: super-admin email + Google + email_verified=true なら 200", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-super",
        email: "super@example.com",
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.superAdmin).toEqual({
      email: "super@example.com",
      firebaseUid: "uid-super",
    });
  });

  it("super-admin email でも email_verified=false なら 403", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-super-unverified",
        email: "super@example.com",
        email_verified: false,
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    // ユーザー列挙防止のため既存メッセージと同一
    expect(res.body.message).toContain("スーパー管理者権限が必要です");
  });

  it("super-admin email でも email_verified が undefined（欠落）なら 403", async () => {
    const { app } = await buildApp();

    // email_verified を明示的に未設定
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-super-missing",
      email: "super@example.com",
      firebase: { sign_in_provider: "google.com", identities: {} },
      // email_verified フィールドなし
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
  });

  it("super-admin email でも sign_in_provider=password なら 403", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-super-password",
        email: "super@example.com",
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("スーパー管理者権限が必要です");
  });

  it("super-admin email でも decodedToken.firebase が undefined なら 403（SDK 形状変化対策、fail-closed）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-super-no-firebase",
      email: "super@example.com",
      email_verified: true,
      // firebase フィールドなし
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
  });

  it("verifyIdToken は checkRevoked=true で呼ばれる（revoke後の即時失効）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-super-check",
        email: "super@example.com",
      })
    );

    await supertest(app).get("/me").set("authorization", "Bearer idToken-xyz");

    expect(mockVerifyIdToken).toHaveBeenCalledWith("idToken-xyz", true);
  });

  it("非 super-admin email + Google + email_verified=true は 403（既存挙動の回帰防止）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-regular",
        email: "regular@example.com",
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("スーパー管理者権限が必要です");
  });

  it("Authorization ヘッダなしは 401（既存挙動の回帰防止）", async () => {
    const { app } = await buildApp();

    const res = await supertest(app).get("/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("decodedToken.email 不在でも 403 (非 super-admin として拒否、non-null assertion 回避)", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-no-email",
        // email フィールドなし
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("スーパー管理者権限が必要です");
  });
});
