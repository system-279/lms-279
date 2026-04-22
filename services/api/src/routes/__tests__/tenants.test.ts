/**
 * POST /api/v2/tenants (routes/tenants.ts) の認証ガード統合テスト
 *
 * 確認対象:
 *   - Issue #294 / ADR-031: `verifyIdToken` 直接呼び出し経路への境界統一
 *     - checkRevoked=true で revoke 後のトークンを拒否
 *     - email_verified=true 必須（未検証メールでのテナント作成禁止）
 *     - sign_in_provider=google.com 必須（IdP 追加時のバイパス防止）
 *     - 不適合時は 403 を返し、成功経路（Firestore アクセス）に進まない
 *
 * スコープ外: テナント作成の正常系（Firestore トランザクション成功経路）は
 *             Firestore モックが広範になるため本テストでは扱わず、別 Issue で担保する。
 *
 * 補足: `verifyAuthToken` は POST `/` と GET `/mine` の両方で共通使用される。
 *       本テストは POST 経路で代表して検証し、GET `/mine` は同じ関数を通るため
 *       ガード効果は自動的に波及する。`verifyAuthToken` の分岐を変更する場合は
 *       `mine` 経路のテストを追加すること。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();
const mockGetFirestore = vi.fn(() => {
  throw new Error(
    "getFirestore should not be called in guard-rejection tests (reached Firestore after guard was supposed to 403)"
  );
});

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => mockGetFirestore(),
}));

function makeDecodedToken(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-default",
    email: "owner@example.com",
    name: "Owner User",
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
}

async function buildApp() {
  const { tenantsRouter } = await import("../tenants.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v2/tenants", tenantsRouter);
  return app;
}

describe("POST /api/v2/tenants — auth guards (Issue #294)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockVerifyIdToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Authorization ヘッダ欠落時は 401", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .post("/api/v2/tenants")
      .send({ name: "Test Org" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("verifyIdToken は checkRevoked=true で呼ばれる", async () => {
    // 正常系に進めないように email_verified=false で 403 に落とす。
    // 目的は "checkRevoked=true" で呼ばれたかだけを検証すること。
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email_verified: false })
    );
    const app = await buildApp();

    await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer id-token-xyz")
      .send({ name: "Test Org" });

    expect(mockVerifyIdToken).toHaveBeenCalledWith("id-token-xyz", true);
  });

  it("email_verified=false なら 403 でテナント作成を拒否", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email_verified: false })
    );
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("unauthorized");
  });

  it("email_verified が undefined（欠落）なら 403", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-missing",
      email: "owner@example.com",
      firebase: { sign_in_provider: "google.com", identities: {} },
      // email_verified フィールドなし
    });
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
  });

  it("sign_in_provider=password なら 403（Google 以外の provider を拒否）", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
  });

  it("decodedToken.firebase が undefined でも 403（fail-closed, SDK 形状変化対策）", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-no-firebase",
      email: "owner@example.com",
      email_verified: true,
      // firebase フィールドなし
    });
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
  });

  it("verifyIdToken が throw（トークン検証失敗）なら従来通り 401", async () => {
    mockVerifyIdToken.mockRejectedValue(
      Object.assign(new Error("token expired"), {
        code: "auth/id-token-expired",
      })
    );
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer expired-token")
      .send({ name: "Test Org" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });
});
