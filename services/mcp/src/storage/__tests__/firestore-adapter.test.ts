import { describe, it, expect } from "vitest";
import { errors } from "oidc-provider";
import { createFirestoreAdapterFactory } from "../firestore-adapter.js";
import { createFakeFirestore } from "./fake-firestore.js";

describe("FirestoreOidcAdapter コントラクトテスト", () => {
  it("upsert/find が往復する", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AccessToken");

    await adapter.upsert("token-1", { jti: "token-1", accountId: "user-1" }, 3600);
    const found = await adapter.find("token-1");

    expect(found).toEqual({ jti: "token-1", accountId: "user-1" });
  });

  it("expiresIn 未指定（Client モデル相当）では expiresAt を書かず、TTL削除対象外になる", async () => {
    const db = createFakeFirestore();
    const factory = createFirestoreAdapterFactory(db);
    const adapter = factory("Client");

    await adapter.upsert("client-1", { client_id: "client-1" });
    const found = await adapter.find("client-1");

    expect(found).toEqual({ client_id: "client-1" });
  });

  it("期限切れの find() は undefined を返す（二重防御）", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AuthorizationCode");

    // expiresAt には猶予300秒(EXPIRY_GRACE_SECONDS)が加算されるため、
    // それを超えて過去にするために十分小さい expiresIn を渡す
    await adapter.upsert("code-1", { jti: "code-1" }, -1000);
    const found = await adapter.find("code-1");

    expect(found).toBeUndefined();
  });

  it("存在しない id の find() は undefined を返す", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AccessToken");

    const found = await adapter.find("nonexistent");

    expect(found).toBeUndefined();
  });

  it("consume() 後の upsert() で consumed がクリアされる（既定MemoryAdapterと同じ挙動）", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AuthorizationCode");

    await adapter.upsert("code-1", { jti: "code-1" }, 60);
    await adapter.consume("code-1");
    let found = await adapter.find("code-1");
    expect(found?.consumed).toBeDefined();

    await adapter.upsert("code-1", { jti: "code-1" }, 60);
    found = await adapter.find("code-1");
    expect(found?.consumed).toBeUndefined();
  });

  it("findByUid が model で限定される", async () => {
    const db = createFakeFirestore();
    const sessionFactory = createFirestoreAdapterFactory(db);
    const sessionAdapter = sessionFactory("Session");
    const otherAdapter = sessionFactory("Interaction");

    await sessionAdapter.upsert("sess-1", { jti: "sess-1", uid: "shared-uid" }, 3600);
    await otherAdapter.upsert("int-1", { jti: "int-1", uid: "shared-uid" }, 3600);

    const found = await sessionAdapter.findByUid("shared-uid");
    expect(found).toEqual({ jti: "sess-1", uid: "shared-uid" });
  });

  it("findByUserCode が model で限定される", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("DeviceCode");

    await adapter.upsert("dc-1", { jti: "dc-1", userCode: "ABCD1234" }, 3600);
    const found = await adapter.findByUserCode("ABCD1234");

    expect(found).toEqual({ jti: "dc-1", userCode: "ABCD1234" });
  });

  it("revokeByGrantId が model で限定して一括削除する", async () => {
    const db = createFakeFirestore();
    const factory = createFirestoreAdapterFactory(db);
    const accessTokenAdapter = factory("AccessToken");
    const refreshTokenAdapter = factory("RefreshToken");

    await accessTokenAdapter.upsert("at-1", { jti: "at-1", grantId: "grant-1" }, 3600);
    await refreshTokenAdapter.upsert("rt-1", { jti: "rt-1", grantId: "grant-1" }, 3600);

    await accessTokenAdapter.revokeByGrantId("grant-1");

    expect(await accessTokenAdapter.find("at-1")).toBeUndefined();
    // 別モデル(RefreshToken)は revokeByGrantId をモデルごとに個別呼び出しする設計のため、
    // AccessToken側のrevokeでは削除されない
    expect(await refreshTokenAdapter.find("rt-1")).toEqual({ jti: "rt-1", grantId: "grant-1" });
  });

  it("destroy() が対象ドキュメントを削除する", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AccessToken");

    await adapter.upsert("token-1", { jti: "token-1" }, 3600);
    await adapter.destroy("token-1");

    expect(await adapter.find("token-1")).toBeUndefined();
  });

  it("destroy() は存在しない id でも例外にならない", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AccessToken");

    await expect(adapter.destroy("nonexistent")).resolves.toBeUndefined();
  });

  it("Firestore禁止文字（/ を含む id）でも例外にならず doc id 化される", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AccessToken");

    const trickyId = "a/b/../c";
    await adapter.upsert(trickyId, { jti: trickyId }, 3600);
    const found = await adapter.find(trickyId);

    expect(found).toEqual({ jti: trickyId });
  });

  it("consume() は存在しない id に対して InvalidGrant を投げる（fail closed）", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AuthorizationCode");

    await expect(adapter.consume("nonexistent")).rejects.toThrow(errors.InvalidGrant);
  });

  it("同一 id への並行 consume() は 1 件のみ成功し、もう 1 件は InvalidGrant になる", async () => {
    const factory = createFirestoreAdapterFactory(createFakeFirestore());
    const adapter = factory("AuthorizationCode");

    await adapter.upsert("code-race", { jti: "code-race" }, 60);

    const results = await Promise.allSettled([adapter.consume("code-race"), adapter.consume("code-race")]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(errors.InvalidGrant);

    const found = await adapter.find("code-race");
    expect(found?.consumed).toBeDefined();
  });
});
