/**
 * B-1 派生: ユーザー削除経路でも Firebase Auth セッションを失効させる検証
 *
 * 検証観点:
 * - 正常系: allowed_email 削除 → user 削除 → revoke の順で完走し 204
 * - C-2 対応: allowed_email 削除が失敗したら user を削除せず 500
 * - revoke ベストエフォート: revoke 失敗でも削除自体は 204
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

  it("allowed_email 削除に失敗したら user を削除せず 500 を返す（C-2回帰防止）", async () => {
    const user = await ds.createUser({
      email: "abort@example.com",
      name: "Abort",
      role: "student",
    });
    vi.spyOn(ds, "deleteAllowedEmailByEmail").mockRejectedValueOnce(new Error("firestore down"));

    const res = await request.delete(`/admin/users/${user.id}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("deletion_partial_failure");
    // user は残ったまま
    expect(await ds.getUserById(user.id)).not.toBeNull();
    // revoke は呼ばれない
    expect(revokeRefreshTokensByEmail).not.toHaveBeenCalled();
  });
});
