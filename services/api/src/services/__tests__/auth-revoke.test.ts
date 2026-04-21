import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetUserByEmail = vi.fn();
const mockRevokeRefreshTokens = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    getUserByEmail: mockGetUserByEmail,
    revokeRefreshTokens: mockRevokeRefreshTokens,
  }),
}));

describe("revokeRefreshTokensByEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetUserByEmail.mockReset();
    mockRevokeRefreshTokens.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dev モードでは何もしない", async () => {
    vi.stubEnv("AUTH_MODE", "dev");
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await revokeRefreshTokensByEmail("user@example.com");

    expect(mockGetUserByEmail).not.toHaveBeenCalled();
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("AUTH_MODE 未設定時も dev 扱いで no-op", async () => {
    vi.stubEnv("AUTH_MODE", "");
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await revokeRefreshTokensByEmail("user@example.com");

    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it("firebase モードで UID を特定して revokeRefreshTokens を呼ぶ", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockResolvedValue({ uid: "uid-abc" });
    mockRevokeRefreshTokens.mockResolvedValue(undefined);
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await revokeRefreshTokensByEmail("user@example.com");

    expect(mockGetUserByEmail).toHaveBeenCalledWith("user@example.com");
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith("uid-abc");
  });

  it("入力 email を trim().toLowerCase() 正規化してから Firebase Auth に渡す", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockResolvedValue({ uid: "uid-x" });
    mockRevokeRefreshTokens.mockResolvedValue(undefined);
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await revokeRefreshTokensByEmail("  USER@Example.COM  ");

    expect(mockGetUserByEmail).toHaveBeenCalledWith("user@example.com");
  });

  it("getUserByEmail の auth/user-not-found は握りつぶして no-op", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    const err = Object.assign(new Error("not found"), { code: "auth/user-not-found" });
    mockGetUserByEmail.mockRejectedValue(err);
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await expect(revokeRefreshTokensByEmail("ghost@example.com")).resolves.toBeUndefined();
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("getUserByEmail のその他のエラーは再 throw", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockRejectedValue(new Error("network error"));
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await expect(revokeRefreshTokensByEmail("user@example.com")).rejects.toThrow("network error");
  });

  it("revokeRefreshTokens 自体の失敗も再 throw する（呼び出し側がベストエフォートを判断）", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockResolvedValue({ uid: "uid-y" });
    mockRevokeRefreshTokens.mockRejectedValue(new Error("quota exceeded"));
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await expect(revokeRefreshTokensByEmail("user@example.com")).rejects.toThrow("quota exceeded");
  });

  it("revokeRefreshTokens が競合状態で user-not-found を返しても握りつぶさない（C-1回帰防止）", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockResolvedValue({ uid: "uid-race" });
    const err = Object.assign(new Error("revoke race"), { code: "auth/user-not-found" });
    mockRevokeRefreshTokens.mockRejectedValue(err);
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await expect(revokeRefreshTokensByEmail("user@example.com")).rejects.toThrow("revoke race");
  });
});
