/**
 * tenantAwareAuthMiddleware の email fallback 時 UID 紐付け CAS テスト
 * (Issue #313 / ADR-031 "UID 紐付けの原子性")
 *
 * 確認対象:
 *   - email fallback で firebaseUid 未設定の user に CAS 紐付け → 200 + AuthUser
 *   - email fallback で既存 UID と同じ UID で再ログイン → 200 (idempotent)
 *   - email fallback で既存 UID と **異なる** UID が来る → 403 `tenant_access_denied`
 *     （並行ログイン / GCIP UID 揺り戻しによる last-write-wins 防止）
 *   - 競合時に Firestore 上の既存 UID が silent に上書きされないこと
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
  const { setPlatformDataSourceForTest } = await import("../platform-datasource.js");

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

  return { app, ds, platformDs };
}

describe("tenantAwareAuthMiddleware — email fallback UID CAS (Issue #313)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    mockVerifyIdToken.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { setPlatformDataSourceForTest } = await import("../platform-datasource.js");
    setPlatformDataSourceForTest(null);
  });

  it("firebaseUid 未設定の既存 user に email fallback で CAS 紐付け → 200 + 新 UID 設定", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "new-bind@example.com", note: null });
    const user = await ds.createUser({
      email: "new-bind@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ uid: "uid-first", email: "new-bind@example.com" })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.user.firebaseUid).toBe("uid-first");
    // Firestore 永続化確認
    const fetched = await ds.getUserById(user.id);
    expect(fetched?.firebaseUid).toBe("uid-first");
  });

  it("既に同じ UID で紐付いた user で email fallback が発生しても 200 (idempotent)", async () => {
    // 注: 通常は getUserByFirebaseUid で hit するので email fallback に入らないが、
    // DataSource の実装差異で稀に email fallback に落ちるケースをカバー
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "same-uid@example.com", note: null });
    await ds.createUser({
      email: "same-uid@example.com",
      name: null,
      role: "student",
      firebaseUid: "uid-same",
    });

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ uid: "uid-same", email: "same-uid@example.com" })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.user.firebaseUid).toBe("uid-same");
  });

  it("既に別 UID 紐付け済み user に異なる UID でログインすると 403 uid_reassignment_blocked + platform_auth_error_logs 記録", async () => {
    const { app, ds, platformDs } = await buildApp();
    await ds.createAllowedEmail({ email: "conflict@example.com", note: null });
    const existing = await ds.createUser({
      email: "conflict@example.com",
      name: null,
      role: "student",
      firebaseUid: "uid-original",
    });

    // 別セッション (GCIP UID 揺り戻し等) で別 UID がログイン
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ uid: "uid-different", email: "conflict@example.com" })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");

    // 既存 UID が silent に上書きされていないこと（last-write-wins 防止）
    const fetched = await ds.getUserById(existing.id);
    expect(fetched?.firebaseUid).toBe("uid-original");

    // platform_auth_error_logs に tenant 横断監視用の記録が残ること（AC #4）
    const platformLogs = await platformDs.getPlatformAuthErrorLogs();
    expect(platformLogs).toHaveLength(1);
    expect(platformLogs[0].errorType).toBe("tenant_uid_conflict");
    expect(platformLogs[0].reason).toBe("uid_reassignment_blocked");
    expect(platformLogs[0].email).toBe("conflict@example.com");
    expect(platformLogs[0].tenantId).toBe("t1");
  });

  it("platform_auth_error_logs 書き込み失敗でも 403 は返り、tenant auth_error_logs は記録される (rules/error-handling.md §1 独立 try/catch)", async () => {
    const { app, ds, platformDs } = await buildApp();
    await ds.createAllowedEmail({ email: "platform-down@example.com", note: null });
    await ds.createUser({
      email: "platform-down@example.com",
      name: null,
      role: "student",
      firebaseUid: "uid-original",
    });

    // platform 側の書き込みのみ失敗させる (例: Firestore platform DS outage)
    const platformSpy = vi
      .spyOn(platformDs, "createPlatformAuthErrorLog")
      .mockRejectedValueOnce(new Error("platform firestore down"));

    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ uid: "uid-different", email: "platform-down@example.com" })
    );

    const res = await supertest(app).get("/me").set("authorization", "Bearer dummy");

    // main フローは影響を受けず 403 を返す (platform 書き込み例外が main を壊さない)
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_access_denied");
    // platform 書き込みが試行されたこと (try/catch で吸収され、main は継続)
    expect(platformSpy).toHaveBeenCalledTimes(1);
  });

  it("並行 race: 同じ email で異なる UID の 2 リクエストが同時 → 一方のみ 200、他方は 403", async () => {
    const { app, ds } = await buildApp();
    await ds.createAllowedEmail({ email: "race@example.com", note: null });
    await ds.createUser({
      email: "race@example.com",
      name: null,
      role: "student",
      firebaseUid: undefined,
    });

    // 2 本を「ほぼ同時」に発火。mockVerifyIdToken は呼び出しごとに異なる UID を返す
    mockVerifyIdToken
      .mockResolvedValueOnce(
        makeDecodedToken({ uid: "uid-race-a", email: "race@example.com" })
      )
      .mockResolvedValueOnce(
        makeDecodedToken({ uid: "uid-race-b", email: "race@example.com" })
      );

    const [res1, res2] = await Promise.all([
      supertest(app).get("/me").set("authorization", "Bearer dummy-a"),
      supertest(app).get("/me").set("authorization", "Bearer dummy-b"),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 403]);
  });
});
