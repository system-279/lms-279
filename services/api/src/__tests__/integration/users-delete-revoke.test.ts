/**
 * B-1 派生: ユーザー削除経路でも Firebase Auth セッションを失効させる検証
 * DELETE /admin/users/:id が allowed_email 削除に加えて
 * revokeRefreshTokensByEmail を呼ぶことを確認する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";

const { revokeRefreshTokensByEmail } = vi.hoisted(() => ({
  revokeRefreshTokensByEmail: vi.fn(),
}));

vi.mock("../../services/auth-revoke.js", () => ({
  revokeRefreshTokensByEmail,
}));

import { createTestApp } from "../helpers/create-app.js";

describe("DELETE /admin/users/:id — refresh token revoke", () => {
  let request: ReturnType<typeof supertest>;
  let ds: ReturnType<typeof createTestApp>["ds"];

  beforeEach(() => {
    revokeRefreshTokensByEmail.mockReset().mockResolvedValue(undefined);
    const app = createTestApp();
    request = supertest(app.app);
    ds = app.ds;
  });

  it("削除成功時に該当メールの revokeRefreshTokensByEmail を呼ぶ", async () => {
    const user = await ds.createUser({
      email: "target@example.com",
      name: "Target",
      role: "student",
    });

    const res = await request.delete(`/admin/users/${user.id}`);

    expect(res.status).toBe(204);
    expect(revokeRefreshTokensByEmail).toHaveBeenCalledWith("target@example.com");
  });

  it("revoke 失敗時もユーザー削除自体は成功する（ベストエフォート）", async () => {
    revokeRefreshTokensByEmail.mockRejectedValueOnce(new Error("firebase unreachable"));
    const user = await ds.createUser({
      email: "besteffort@example.com",
      name: "Best Effort",
      role: "student",
    });

    const res = await request.delete(`/admin/users/${user.id}`);

    expect(res.status).toBe(204);
    expect(await ds.getUserById(user.id)).toBeNull();
  });

  it("存在しない id では revoke を呼ばず 404 を返す", async () => {
    const res = await request.delete("/admin/users/does-not-exist");

    expect(res.status).toBe(404);
    expect(revokeRefreshTokensByEmail).not.toHaveBeenCalled();
  });
});
