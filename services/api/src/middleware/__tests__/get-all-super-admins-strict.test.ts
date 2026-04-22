/**
 * getAllSuperAdminsStrict / getAllSuperAdmins の fail-closed / silent fallback
 * 挙動を検証する単体テスト (Issue #296)。
 *
 * 方針:
 *   - getAllSuperAdminsStrict: Firestore 障害時に SuperAdminFirestoreUnavailableError
 *     を throw する（破壊的操作のための fail-closed 版）
 *   - getAllSuperAdmins: Firestore 障害時も env 分を silent fallback で返す
 *     （一覧表示の可用性維持、UX 優先）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFirestoreGet = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: vi.fn(),
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

describe("getAllSuperAdminsStrict (Issue #296 fail-closed)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "env-admin@example.com");
    mockFirestoreGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Firestore 成功時は env + firestore の admins を返す", async () => {
    const { getAllSuperAdminsStrict } = await import("../super-admin.js");

    mockFirestoreGet.mockResolvedValue({
      docs: [
        {
          id: "firestore-admin@example.com",
          data: () => ({ addedAt: "2026-04-01T00:00:00Z", addedBy: "system" }),
        },
      ],
    });

    const admins = await getAllSuperAdminsStrict();
    expect(admins).toEqual([
      { email: "env-admin@example.com", source: "env" },
      {
        email: "firestore-admin@example.com",
        source: "firestore",
        addedAt: "2026-04-01T00:00:00Z",
        addedBy: "system",
      },
    ]);
  });

  it("Firestore 障害時は SuperAdminFirestoreUnavailableError を throw する (fail-closed)", async () => {
    const { getAllSuperAdminsStrict, SuperAdminFirestoreUnavailableError } =
      await import("../super-admin.js");

    mockFirestoreGet.mockRejectedValue(
      Object.assign(new Error("service unavailable"), { code: "unavailable" })
    );

    await expect(getAllSuperAdminsStrict()).rejects.toBeInstanceOf(
      SuperAdminFirestoreUnavailableError
    );
  });

  it("env と firestore で重複した email は env 優先で firestore 側を除外する", async () => {
    const { getAllSuperAdminsStrict } = await import("../super-admin.js");

    mockFirestoreGet.mockResolvedValue({
      docs: [
        {
          id: "env-admin@example.com",
          data: () => ({ addedAt: "2026-04-01T00:00:00Z" }),
        },
        {
          id: "firestore-only@example.com",
          data: () => ({ addedAt: "2026-04-02T00:00:00Z" }),
        },
      ],
    });

    const admins = await getAllSuperAdminsStrict();
    expect(admins).toHaveLength(2);
    expect(admins[0]).toEqual({ email: "env-admin@example.com", source: "env" });
    expect(admins[1].email).toBe("firestore-only@example.com");
  });
});

describe("getAllSuperAdmins (Issue #296 silent fallback 継続)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "firebase");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "env-admin@example.com");
    mockFirestoreGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Firestore 障害時も env 分だけを silent fallback で返す (既存挙動、一覧取得の可用性維持)", async () => {
    const { getAllSuperAdmins } = await import("../super-admin.js");

    mockFirestoreGet.mockRejectedValue(
      Object.assign(new Error("service unavailable"), { code: "unavailable" })
    );

    // 破壊的挙動ではないのでエラーを投げず、env admin のみ返す
    const admins = await getAllSuperAdmins();
    expect(admins).toEqual([{ email: "env-admin@example.com", source: "env" }]);
  });

  it("Firestore 成功時は env + firestore の admins を返す", async () => {
    const { getAllSuperAdmins } = await import("../super-admin.js");

    mockFirestoreGet.mockResolvedValue({
      docs: [
        {
          id: "firestore-admin@example.com",
          data: () => ({ addedAt: "2026-04-01T00:00:00Z", addedBy: "system" }),
        },
      ],
    });

    const admins = await getAllSuperAdmins();
    expect(admins).toEqual([
      { email: "env-admin@example.com", source: "env" },
      {
        email: "firestore-admin@example.com",
        source: "firestore",
        addedAt: "2026-04-01T00:00:00Z",
        addedBy: "system",
      },
    ]);
  });
});
