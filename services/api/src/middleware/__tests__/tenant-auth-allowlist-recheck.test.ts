/**
 * Issue #278: allowed_emails の継続的認可境界（案B）統合テスト
 *
 * tenantAwareAuthMiddleware が既存ユーザー経路（firebaseUid 一致 / email 一致 /
 * dev x-user-id / dev x-user-email）でも毎リクエスト allowed_emails を再チェックし、
 * 削除後の既存セッションでアクセスが残らないことを検証する。
 *
 * Acceptance Criteria (Issue #278):
 *   1. 既存 user + allowed_email 削除 → 次回リクエストで 403
 *   2. allowed_email 再追加で復帰、進捗データも維持されている
 *   3. スーパー管理者は allowed_emails 無関係にアクセス可
 *   4. dev 経路（x-user-email / x-user-id 両方）も同等
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();
const mockIsSuperAdmin = vi.fn();

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
  isSuperAdmin: (email?: string) => mockIsSuperAdmin(email),
}));

async function buildApp(mode: "firebase" | "dev") {
  vi.stubEnv("AUTH_MODE", mode);
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
    res.json({
      user: req.user ?? null,
      isSuperAdminAccess: req.isSuperAdminAccess ?? false,
    });
  });

  return { app, ds };
}

describe("tenantAwareAuthMiddleware — allowed_emails continuous re-check (Issue #278)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockVerifyIdToken.mockReset();
    mockIsSuperAdmin.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("AC1/2: firebase mode existingByUid 経路", () => {
    it("allowed_email 削除後のリクエストで 403 を返す", async () => {
      const { app, ds } = await buildApp("firebase");
      const allowed = await ds.createAllowedEmail({ email: "user@example.com", note: null });
      const user = await ds.createUser({
        email: "user@example.com",
        name: "User",
        role: "student",
        firebaseUid: "uid-1",
      });

      mockVerifyIdToken.mockResolvedValue({
        uid: "uid-1",
        email: "user@example.com",
        name: "User",
      });

      // 削除前は 200
      const before = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(before.status).toBe(200);
      expect(before.body.user.id).toBe(user.id);

      // allowed_email 削除 → 次回リクエストで 403
      await ds.deleteAllowedEmail(allowed.id);
      const after = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(after.status).toBe(403);
      expect(after.body.error).toBe("tenant_access_denied");

      // user レコードは削除されていない（進捗データ保持の前提）
      const stillExists = await ds.getUserById(user.id);
      expect(stillExists).not.toBeNull();
      expect(stillExists?.email).toBe("user@example.com");

      // allowed_email 再追加 → 復帰（同じ user.id が返ること = 進捗データ維持）
      await ds.createAllowedEmail({ email: "user@example.com", note: null });
      const restored = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(restored.status).toBe(200);
      expect(restored.body.user.id).toBe(user.id);
    });
  });

  describe("AC1: firebase mode existingByEmail 経路", () => {
    it("allowed_email 未登録の既存 user は 403（firebaseUid も書き込まれない）", async () => {
      const { app, ds } = await buildApp("firebase");
      // user は存在するが allowed_emails に登録なし（棚卸し対象外れのシナリオ）
      const user = await ds.createUser({
        email: "no-allowed@example.com",
        name: "User",
        role: "student",
      });

      mockVerifyIdToken.mockResolvedValue({
        uid: "uid-new",
        email: "no-allowed@example.com",
      });

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(403);

      // firebaseUid が書き込まれていないこと（未許可ユーザーにUIDを紐付けない）
      const afterUser = await ds.getUserById(user.id);
      expect(afterUser?.firebaseUid).toBeUndefined();
    });
  });

  describe("AC3: スーパー管理者のみ allowed_emails 無関係にアクセス可", () => {
    it("firebase mode: super admin は allowed_emails 不在でも 200", async () => {
      const { app, ds } = await buildApp("firebase");
      const user = await ds.createUser({
        email: "super@example.com",
        name: "Super",
        role: "student",
        firebaseUid: "uid-super",
      });

      mockIsSuperAdmin.mockResolvedValue(true);
      mockVerifyIdToken.mockResolvedValue({
        uid: "uid-super",
        email: "super@example.com",
      });

      // allowed_emails に一切登録がない状態
      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(user.id);
      expect(res.body.user.role).toBe("admin"); // super admin override
      expect(res.body.isSuperAdminAccess).toBe(true);
    });

    it("firebase mode: tenant admin role 単体は allowlist バイパス不可（403）", async () => {
      // 重要: DB の role=admin は tenant 内の権限であり、allowlist バイパス権ではない
      const { app, ds } = await buildApp("firebase");
      await ds.createUser({
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
      });
      // allowed_emails 未登録、super admin でもない
      mockIsSuperAdmin.mockResolvedValue(false);
      mockVerifyIdToken.mockResolvedValue({
        uid: "uid-admin-new",
        email: "admin@example.com",
      });

      const res = await supertest(app).get("/me").set("authorization", "Bearer tok");
      expect(res.status).toBe(403);
    });
  });

  describe("AC4: dev mode でも同等の継続的認可境界", () => {
    it("x-user-email 経路: allowed_email 削除後のリクエストで 403", async () => {
      const { app, ds } = await buildApp("dev");
      const allowed = await ds.createAllowedEmail({ email: "dev@example.com", note: null });
      await ds.createUser({
        email: "dev@example.com",
        name: "Dev",
        role: "student",
      });

      const before = await supertest(app).get("/me").set("x-user-email", "dev@example.com");
      expect(before.status).toBe(200);
      expect(before.body.user?.email).toBe("dev@example.com");

      await ds.deleteAllowedEmail(allowed.id);
      const after = await supertest(app).get("/me").set("x-user-email", "dev@example.com");
      expect(after.status).toBe(403);
    });

    it("x-user-id 経路: allowed_email 削除後のリクエストで 403", async () => {
      const { app, ds } = await buildApp("dev");
      const allowed = await ds.createAllowedEmail({ email: "dev-byid@example.com", note: null });
      const user = await ds.createUser({
        email: "dev-byid@example.com",
        name: "Dev ById",
        role: "student",
      });

      const before = await supertest(app).get("/me").set("x-user-id", user.id);
      expect(before.status).toBe(200);

      await ds.deleteAllowedEmail(allowed.id);
      const after = await supertest(app).get("/me").set("x-user-id", user.id);
      expect(after.status).toBe(403);
    });

    it("x-user-id 経路: スーパー管理者は allowed_email 無しでもアクセス可", async () => {
      const { app, ds } = await buildApp("dev");
      const user = await ds.createUser({
        email: "dev-super@example.com",
        name: "DevSuper",
        role: "student",
      });
      // allowed_emails には登録しない
      mockIsSuperAdmin.mockResolvedValue(true);

      const res = await supertest(app).get("/me").set("x-user-id", user.id);
      expect(res.status).toBe(200);
      expect(res.body.isSuperAdminAccess).toBe(true);
      expect(res.body.user.role).toBe("admin");
    });
  });
});
