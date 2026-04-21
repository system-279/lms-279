/**
 * 許可メール API 統合テスト（B-1: 削除時セッション失効 / B-3: メール正規化）
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

describe("Allowed Emails API", () => {
  let request: ReturnType<typeof supertest>;
  let ds: ReturnType<typeof createTestApp>["ds"];

  beforeEach(() => {
    revokeRefreshTokensByEmail.mockReset().mockResolvedValue(undefined);
    const app = createTestApp();
    request = supertest(app.app);
    ds = app.ds;
  });

  describe("POST /admin/allowed-emails", () => {
    it("前後空白と大文字を正規化して保存する", async () => {
      const res = await request
        .post("/admin/allowed-emails")
        .send({ email: "  USER@Example.COM  " });

      expect(res.status).toBe(201);
      expect(res.body.allowedEmail.email).toBe("user@example.com");
    });

    it("正規化後に既存と一致する場合 409 を返す", async () => {
      await request.post("/admin/allowed-emails").send({ email: "user@example.com" });

      const res = await request
        .post("/admin/allowed-emails")
        .send({ email: "USER@example.com" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("email_exists");
    });

    it("不正な email 形式で 400 を返す", async () => {
      const res = await request
        .post("/admin/allowed-emails")
        .send({ email: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_email");
    });

    it("空白のみの email で 400 を返す（trim 後に空）", async () => {
      const res = await request
        .post("/admin/allowed-emails")
        .send({ email: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_email");
    });
  });

  describe("DELETE /admin/allowed-emails/:id", () => {
    it("存在する id を削除すると 204 を返し revokeRefreshTokensByEmail を呼ぶ", async () => {
      const created = await ds.createAllowedEmail({ email: "revoke@example.com", note: null });

      const res = await request.delete(`/admin/allowed-emails/${created.id}`);

      expect(res.status).toBe(204);
      expect(revokeRefreshTokensByEmail).toHaveBeenCalledTimes(1);
      expect(revokeRefreshTokensByEmail).toHaveBeenCalledWith("revoke@example.com");

      const all = await ds.getAllowedEmails();
      expect(all.find((e) => e.id === created.id)).toBeUndefined();
    });

    it("存在しない id は 404 を返し revoke は呼ばれない", async () => {
      const res = await request.delete("/admin/allowed-emails/nonexistent");

      expect(res.status).toBe(404);
      expect(revokeRefreshTokensByEmail).not.toHaveBeenCalled();
    });

    it("revoke が失敗しても削除自体は成功する（ベストエフォート）", async () => {
      revokeRefreshTokensByEmail.mockRejectedValueOnce(new Error("firebase unreachable"));
      const created = await ds.createAllowedEmail({ email: "best@example.com", note: null });

      const res = await request.delete(`/admin/allowed-emails/${created.id}`);

      expect(res.status).toBe(204);
      const all = await ds.getAllowedEmails();
      expect(all.find((e) => e.id === created.id)).toBeUndefined();
    });
  });

  describe("isEmailAllowed 正規化（DataSource レベル）", () => {
    it("大文字混入の登録データも小文字クエリで一致する", async () => {
      await ds.createAllowedEmail({ email: "CaseSensitive@Example.com", note: null });

      const result = await ds.isEmailAllowed("casesensitive@example.com");

      expect(result).toBe(true);
    });

    it("前後空白混入のクエリでも既存データと一致する", async () => {
      await ds.createAllowedEmail({ email: "user@example.com", note: null });

      const result = await ds.isEmailAllowed("  user@example.com  ");

      expect(result).toBe(true);
    });
  });
});
