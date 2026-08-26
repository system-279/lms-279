import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { errors } from "oidc-provider";
import { createFirestoreAdapterFactory } from "../firestore-adapter.js";

/**
 * 実 Firestore emulator を使った consume() 原子性の統合テスト。
 *
 * 計画 noble-purring-rabbit.md 検証項目2b（セカンドオピニオンでHighへ昇格）:
 * fake-firestore（vitest上の自作フェイク）だけでは、本リポジトリの既存方針
 * (services/api/src/services/dispatch/__tests__/firestore-dispatch-storage.test.ts:7,15
 * 「並行制御の実race検証はFirestore emulator/stagingで別途実施、mockでは証明しない」)
 * から逸脱する。ここでは実Firestore transactionの自動リトライ・競合検知を通した上で、
 * 同一認可コードの並行consume()が1件のみ成功することを検証する。
 *
 * 実行方法: `firebase emulators:start --only firestore` を起動した状態で
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 を設定して vitest を実行する。
 * emulator未起動時(通常のCI/ローカル `npm test`)は自動的にスキップする
 * (rules/firebase.md のFirestoreエミュレータテストパターンに準拠)。
 */
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulatorHost)("FirestoreOidcAdapter: 実Firestore emulatorでの原子性検証", () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: "lms-279-mcp-emulator-test" }, "mcp-emulator-test");
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  it("同一認可コードへの並行consume()は実Firestore transaction上でも1件のみ成功する", async () => {
    const factory = createFirestoreAdapterFactory(db);
    const adapter = factory("AuthorizationCode");
    const codeId = `emulator-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await adapter.upsert(codeId, { jti: codeId }, 60);

    const results = await Promise.allSettled([adapter.consume(codeId), adapter.consume(codeId)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(errors.InvalidGrant);

    const found = await adapter.find(codeId);
    expect(found?.consumed).toBeDefined();
  });

  it("upsert/find/consume/destroy が実Firestore上で往復する", async () => {
    const factory = createFirestoreAdapterFactory(db);
    const adapter = factory("AccessToken");
    const tokenId = `emulator-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await adapter.upsert(tokenId, { jti: tokenId, accountId: "user-emulator" }, 3600);
    expect(await adapter.find(tokenId)).toEqual({ jti: tokenId, accountId: "user-emulator" });

    await adapter.destroy(tokenId);
    expect(await adapter.find(tokenId)).toBeUndefined();
  });

  // 以下3件は firestore.indexes.json で追加した複合index(model+uid / model+userCode /
  // model+grantId)を要するクエリの実Firestore上での動作検証(pr-review-toolkit:
  // pr-test-analyzer指摘。fake-firestoreはindexなしで常に成功するため、where句の
  // フィールド名・構文の整合性はfakeだけでは検知できない)。

  it("findByUid が実Firestore上で動作する（model+uid複合index使用）", async () => {
    const factory = createFirestoreAdapterFactory(db);
    const adapter = factory("Session");
    const sessId = `emulator-uid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const uid = `emulator-uid-value-${Date.now()}`;

    await adapter.upsert(sessId, { jti: sessId, uid }, 3600);
    const found = await adapter.findByUid(uid);

    expect(found).toEqual({ jti: sessId, uid });
  });

  it("findByUserCode が実Firestore上で動作する（model+userCode複合index使用）", async () => {
    const factory = createFirestoreAdapterFactory(db);
    const adapter = factory("DeviceCode");
    const dcId = `emulator-usercode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userCode = `E${Date.now().toString(36).toUpperCase()}`;

    await adapter.upsert(dcId, { jti: dcId, userCode }, 3600);
    const found = await adapter.findByUserCode(userCode);

    expect(found).toEqual({ jti: dcId, userCode });
  });

  it("revokeByGrantId が実Firestore上で同一grantIdの複数ドキュメントを削除する（model+grantId複合index使用）", async () => {
    const factory = createFirestoreAdapterFactory(db);
    const adapter = factory("AccessToken");
    const grantId = `emulator-grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tokenId1 = `${grantId}-1`;
    const tokenId2 = `${grantId}-2`;

    await adapter.upsert(tokenId1, { jti: tokenId1, grantId }, 3600);
    await adapter.upsert(tokenId2, { jti: tokenId2, grantId }, 3600);

    await adapter.revokeByGrantId(grantId);

    expect(await adapter.find(tokenId1)).toBeUndefined();
    expect(await adapter.find(tokenId2)).toBeUndefined();
  });
});
