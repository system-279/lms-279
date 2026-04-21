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

  it("firebase モードで UID を特定して revokeRefreshTokens を呼ぶ", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockResolvedValue({ uid: "uid-abc" });
    mockRevokeRefreshTokens.mockResolvedValue(undefined);
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await revokeRefreshTokensByEmail("user@example.com");

    expect(mockGetUserByEmail).toHaveBeenCalledWith("user@example.com");
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith("uid-abc");
  });

  it("auth/user-not-found エラーは握りつぶして no-op にする", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    const err = Object.assign(new Error("not found"), { code: "auth/user-not-found" });
    mockGetUserByEmail.mockRejectedValue(err);
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await expect(revokeRefreshTokensByEmail("ghost@example.com")).resolves.toBeUndefined();
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("その他のエラーは再 throw する", async () => {
    vi.stubEnv("AUTH_MODE", "firebase");
    mockGetUserByEmail.mockRejectedValue(new Error("network error"));
    const { revokeRefreshTokensByEmail } = await import("../auth-revoke.js");

    await expect(revokeRefreshTokensByEmail("user@example.com")).rejects.toThrow("network error");
  });
});
