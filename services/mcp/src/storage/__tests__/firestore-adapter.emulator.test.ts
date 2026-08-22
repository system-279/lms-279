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
});
