/**
 * superAdminAuthMiddleware (AUTH_MODE=firebase) Firestore 障害時の fail-closed 挙動 (Issue #293)
 *
 * 背景:
 *   PR #291 silent-failure-hunter CRITICAL-2 指摘。
 *   `getSuperAdminsFromFirestore` は Firestore 障害時に空配列を silent に返していたため、
 *   Firestore 登録された super-admin が 403 で締め出される一方で env フォールバックは
 *   通過する「部分 fail-open + ユーザー欺瞞」状態だった。
 *
 * 本テストは以下を検証:
 *   - Firestore 障害時は 503 Service Unavailable で返却（env フォールバックが効くケースを除く）
 *   - env 経由 super-admin は Firestore 障害でも通過する（高速パス）
 *   - 通常の Firestore 障害なし + 非 super-admin は引き続き 403（既存挙動の回帰防止）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();
const mockFirestoreGet = vi.fn();

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
      get: mockFirestoreGet,
    }),
  }),
}));

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

describe("superAdminAuthMiddleware (firebase mode) — Issue #293: Firestore fail-closed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "env-admin@example.com");
    mockVerifyIdToken.mockReset();
    mockFirestoreGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("env フォールバックに載っている super-admin は Firestore 障害でも 200（高速パス）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-env-admin",
        email: "env-admin@example.com",
      })
    );
    // Firestore は障害を throw するが、env 高速パスで通過する設計
    mockFirestoreGet.mockRejectedValue(new Error("UNAVAILABLE: Firestore down"));

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.superAdmin.email).toBe("env-admin@example.com");
  });

  it("Firestore 障害 + env に載っていない super-admin は 503（silent 403 ではない）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-firestore-admin",
        email: "firestore-admin@example.com",
      })
    );
    mockFirestoreGet.mockRejectedValue(new Error("UNAVAILABLE: Firestore down"));

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("service_unavailable");
    expect(res.body.message).toContain("一時的に利用できません");
  });

  it("Firestore 正常 + 非 super-admin email は引き続き 403（既存挙動の回帰防止）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-regular",
        email: "regular@example.com",
      })
    );
    // Firestore は docs 空で成功
    mockFirestoreGet.mockResolvedValue({ docs: [] });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("スーパー管理者権限が必要です");
  });

  it("Firestore 正常 + Firestore 登録 super-admin は 200（既存挙動の回帰防止）", async () => {
    const { app } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-firestore-admin",
        email: "firestore-admin@example.com",
      })
    );
    // Firestore に docs が存在
    mockFirestoreGet.mockResolvedValue({
      docs: [{ id: "firestore-admin@example.com" }],
    });

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.superAdmin.email).toBe("firestore-admin@example.com");
  });
});

describe("superAdminAuthMiddleware (dev mode) — Issue #293: Firestore fail-closed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "dev");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "env-admin@example.com");
    mockVerifyIdToken.mockReset();
    mockFirestoreGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("env フォールバック super-admin は Firestore 障害でも 200（dev mode 高速パス）", async () => {
    const { app } = await buildApp();
    // Firestore は障害を throw するが、env 高速パスで通過する設計
    mockFirestoreGet.mockRejectedValue(new Error("UNAVAILABLE: Firestore down"));

    const res = await supertest(app).get("/me").set("x-user-email", "env-admin@example.com");

    expect(res.status).toBe(200);
    expect(res.body.superAdmin.email).toBe("env-admin@example.com");
  });

  it("env 未登録 + Firestore 障害は 503 (dev mode でも silent 403 を防ぐ)", async () => {
    const { app } = await buildApp();
    mockFirestoreGet.mockRejectedValue(new Error("UNAVAILABLE: Firestore down"));

    const res = await supertest(app)
      .get("/me")
      .set("x-user-email", "firestore-admin@example.com");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("service_unavailable");
    expect(res.body.message).toContain("一時的に利用できません");
  });

  it("Firestore 正常 + 非 super-admin は 403（既存挙動の回帰防止）", async () => {
    const { app } = await buildApp();
    mockFirestoreGet.mockResolvedValue({ docs: [] });

    const res = await supertest(app).get("/me").set("x-user-email", "regular@example.com");

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("スーパー管理者権限が必要です");
  });
});

describe("isSuperAdmin (unit) — Issue #293: Firestore throw contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SUPER_ADMIN_EMAILS", "env-admin@example.com");
    mockFirestoreGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("env に登録済みなら Firestore 障害でも true を返す（高速パス契約）", async () => {
    const { isSuperAdmin } = await import("../super-admin.js");
    mockFirestoreGet.mockRejectedValue(new Error("UNAVAILABLE: Firestore down"));

    await expect(isSuperAdmin("env-admin@example.com")).resolves.toBe(true);
    // Firestore には到達しないはず
    expect(mockFirestoreGet).not.toHaveBeenCalled();
  });

  it("env 未登録かつ Firestore 障害なら SuperAdminFirestoreUnavailableError を throw", async () => {
    const { isSuperAdmin, SuperAdminFirestoreUnavailableError } = await import(
      "../super-admin.js"
    );
    const firestoreErr = Object.assign(new Error("Firestore down"), {
      code: "unavailable",
    });
    mockFirestoreGet.mockRejectedValue(firestoreErr);

    await expect(isSuperAdmin("unknown@example.com")).rejects.toBeInstanceOf(
      SuperAdminFirestoreUnavailableError
    );
  });

  it("SuperAdminFirestoreUnavailableError は code と cause を保持する（#292 での分類用）", async () => {
    const { isSuperAdmin, SuperAdminFirestoreUnavailableError } = await import(
      "../super-admin.js"
    );
    const firestoreErr = Object.assign(new Error("Firestore down"), {
      code: "unavailable",
    });
    mockFirestoreGet.mockRejectedValue(firestoreErr);

    try {
      await isSuperAdmin("unknown@example.com");
      expect.fail("Expected throw but got fulfilled promise");
    } catch (err) {
      expect(err).toBeInstanceOf(SuperAdminFirestoreUnavailableError);
      const e = err as InstanceType<typeof SuperAdminFirestoreUnavailableError>;
      expect(e.code).toBe("unavailable");
      expect(e.cause).toBe(firestoreErr);
      expect(e.message).toContain("SUPER_ADMIN_FIRESTORE_UNAVAILABLE");
    }
  });
});
