/**
 * tenantAwareAuthMiddleware の「初回 create 経路の atomic 化」テスト (Issue #316 / ADR-031)
 *
 * Sub-Issue C (#313) で email fallback (既存 user) は CAS 化済。本ファイルは
 * 「両方 miss → atomic findOrCreate」経路の race 解消を検証する。
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
  const { setPlatformDataSourceForTest } = await import(
    "../platform-datasource.js"
  );

  const ds = new InMemoryDataSource({ readOnly: false });
  const platformDs = new InMemoryDataSource({ readOnly: false });
  setPlatformDataSourceForTest(platformDs);

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

describe("tenantAwareAuthMiddleware — atomic findOrCreate 経路 (Issue #316)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    mockVerifyIdToken.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { setPlatformDataSourceForTest } = await import(
      "../platform-datasource.js"
    );
    setPlatformDataSourceForTest(null);
  });

  it("初回ログイン (allowed_emails 登録済): user 新規作成 + UID 紐付け + 200", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "first-login@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-first",
        email: "first-login@example.com",
        name: "New User",
      })
    );

    const res = await supertest(app)
      .get("/me")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("first-login@example.com");
    expect(res.body.user.firebaseUid).toBe("uid-first");
    expect(res.body.user.role).toBe("student");

    // user 永続化確認
    const fetched = await ds.getUserByEmail("first-login@example.com");
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("New User");
    expect(fetched?.firebaseUid).toBe("uid-first");
  });

  it("初回ログイン (allowed_emails 未登録): 403 not_in_allowlist + user 作成されない", async () => {
    const { app, ds } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        uid: "uid-blocked",
        email: "not-allowed@example.com",
      })
    );

    const res = await supertest(app)
      .get("/me")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");

    // user は作成されていないこと (allowlist チェックが findOrCreate より前)
    const fetched = await ds.getUserByEmail("not-allowed@example.com");
    expect(fetched).toBeNull();
  });

  it("並行 race (新規 email, 異なる UID): 同時 2 リクエスト → 1 件のみ user 作成、勝者 200 / 敗者 403", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "race-create@example.com", note: null });

    mockVerifyIdToken
      .mockResolvedValueOnce(
        makeDecodedToken({ uid: "uid-a", email: "race-create@example.com" })
      )
      .mockResolvedValueOnce(
        makeDecodedToken({ uid: "uid-b", email: "race-create@example.com" })
      );

    const [res1, res2] = await Promise.all([
      supertest(app).get("/me").set("authorization", "Bearer dummy-a"),
      supertest(app).get("/me").set("authorization", "Bearer dummy-b"),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 403]);

    // user は 1 件のみ作成され、勝者の UID で紐付けされている
    const all = await ds.getUsers();
    const matched = all.filter((u) => u.email === "race-create@example.com");
    expect(matched).toHaveLength(1);
    expect(matched[0].firebaseUid).toMatch(/^uid-[ab]$/);
  });

  it("並行 race (新規 email, 同 UID): 同時 2 リクエスト → 1 件のみ user 作成、両方 200", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "race-same-uid@example.com", note: null });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ uid: "uid-shared", email: "race-same-uid@example.com" })
    );

    const [res1, res2] = await Promise.all([
      supertest(app).get("/me").set("authorization", "Bearer dummy-a"),
      supertest(app).get("/me").set("authorization", "Bearer dummy-b"),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const all = await ds.getUsers();
    const matched = all.filter((u) => u.email === "race-same-uid@example.com");
    expect(matched).toHaveLength(1);
    expect(matched[0].firebaseUid).toBe("uid-shared");
  });

  it("email 欠落 token: 403 email_missing + user 作成されない", async () => {
    const { app, ds } = await buildApp();

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ uid: "uid-no-email", email: undefined })
    );

    const res = await supertest(app)
      .get("/me")
      .set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
    // この経路で新たに user が作成されていないこと (initialUsers は触れない前提)
    const all = await ds.getUsers();
    const newlyBound = all.filter((u) => u.firebaseUid === "uid-no-email");
    expect(newlyBound).toHaveLength(0);
  });
});
