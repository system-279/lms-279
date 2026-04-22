/**
 * tenantAwareAuthMiddleware (AUTH_MODE=firebase) 統合テスト
 *
 * 確認対象:
 *   - CG-1: email 正規化（trim + toLowerCase）が decodedToken から実経路で行われる
 *   - H-A: verifyIdToken が checkRevoked=true で呼ばれる（revoke 後の即時失効）
 *   - Issue #286: email_verified / sign_in_provider の必須チェック
 *     - ADR-031「allowed_emails 境界の必須条件 #1, #2」対応
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

/**
 * Google プロバイダ + 検証済みメールの標準 decodedToken を生成するヘルパー。
 * Issue #286 で必須化された `email_verified` / `firebase.sign_in_provider` を
 * すべてのテストでデフォルト有効化し、失敗系テストは明示的に override する。
 */
function makeDecodedToken(overrides: Record<string, unknown> = {}) {
  return {
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
}

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

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-abc",
        email: "  CASE-Insensitive@Example.COM  ",
        name: "CI User",
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.email).toBe("case-insensitive@example.com");
  });

  it("decodedToken.email 不在でも allowed_emails に該当しないため 403", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-no-email",
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
  });

  it("verifyIdToken は checkRevoked=true で呼ばれる（H-A: revoke後の即時失効）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-check",
        email: "check@example.com",
      })
    );

    await supertest(app).get("/me").set("authorization", "Bearer idToken-xyz");

    expect(mockVerifyIdToken).toHaveBeenCalledWith("idToken-xyz", true);
  });
});

describe("tenantAwareAuthMiddleware (firebase mode) — Issue #286: email_verified / sign_in_provider", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    mockVerifyIdToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("email_verified=false のトークンは 403（未検証メールでのログイン拒否）", async () => {
    const { app, ds } = await buildApp();
    // allowed_emails に登録済みでも拒否されることを確認
    await ds.createAllowedEmail({ email: "unverified@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-unverified",
        email: "unverified@example.com",
        email_verified: false,
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
    // ユーザー列挙防止のため、メッセージは一般化文言で統一
    expect(res.body.message).toContain("アクセス権限がありません");
  });

  it("email_verified が undefined（欠落）のトークンは 403", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "missing-verified@example.com", note: null });

    // email_verified を明示的に未設定（undefined）にする
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-missing-verified",
      email: "missing-verified@example.com",
      firebase: { sign_in_provider: "google.com", identities: {} },
      // email_verified フィールドなし
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
  });

  it("sign_in_provider=password のトークンは 403（Google 以外の provider を拒否）", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "password-user@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-password",
        email: "password-user@example.com",
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
    expect(res.body.message).toContain("アクセス権限がありません");
  });

  it("sign_in_provider=google.com + email_verified=true + allowed_emails 登録済みなら 200", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "google-user@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-google",
        email: "google-user@example.com",
        name: "Google User",
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.email).toBe("google-user@example.com");
  });

  // 配置（findOrCreateTenantUser 冒頭、既存ユーザー検索より前）が security contract。
  // リファクタで既存ユーザー検索後にガードが移動されると allowlist バイパス攻撃面が
  // 復活するため、経路別にガードの効き目を固定する。
  it("既存ユーザー (firebaseUid 一致) でも sign_in_provider=password なら 403（バイパス防止）", async () => {
    const { app, ds } = await buildApp();
    // 事前に Google でログイン済みユーザーを作成
    await ds.createUser({
      email: "existing@example.com",
      name: "Existing User",
      role: "student",
      firebaseUid: "uid-existing",
    });

    // その後、password provider で同じ uid のトークンが提示されたシナリオ
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-existing",
        email: "existing@example.com",
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
  });

  it("既存ユーザー (firebaseUid 一致) でも email_verified=false なら 403", async () => {
    const { app, ds } = await buildApp();
    await ds.createUser({
      email: "existing2@example.com",
      name: "Existing User 2",
      role: "student",
      firebaseUid: "uid-existing-2",
    });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-existing-2",
        email: "existing2@example.com",
        email_verified: false,
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
  });

  it("スーパー管理者 email でも sign_in_provider=password なら 403（super-admin バイパス防止）", async () => {
    const { isSuperAdmin } = await import("../super-admin.js");
    (isSuperAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-super",
        email: "super@example.com",
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");

    // 次テストに影響しないようにモック状態を戻す
    (isSuperAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  it("スーパー管理者 email でも email_verified=false なら 403", async () => {
    const { isSuperAdmin } = await import("../super-admin.js");
    (isSuperAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-super-unverified",
        email: "super-unverified@example.com",
        email_verified: false,
      })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);

    (isSuperAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  it("decodedToken.firebase 自体が undefined なら 403（fail-closed、SDK 形状変化対策）", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "no-firebase@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-no-firebase",
      email: "no-firebase@example.com",
      email_verified: true,
      // firebase フィールドなし（SDK バージョン差 / モックトークン / カスタムトークン想定）
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
  });
});
