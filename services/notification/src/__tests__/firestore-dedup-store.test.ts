/**
 * FirestoreDedupStore（本番実装）自体を対象にしたテスト。
 *
 * pr-review-toolkit の2つの独立レビュー（code-reviewer, pr-test-analyzer）が共に
 * 「FirestoreDedupStore クラス自体はテストされておらず、InMemoryDedupStore という
 * 別実装がテストされているだけ」というカバレッジ0%の穴を指摘した（dedup-store.test.ts
 * は InMemoryDedupStore を対象にしている。ファイル名との齟齬はそちらで別途明示）。
 * 本ファイルは FakeFirestore（.where() 対応・update() を真の部分マージに修正済み）を
 * 通して FirestoreDedupStore の decide/rollback/listPendingFlush/markFlushed を
 * 直接検証する。
 */
import { describe, it, expect } from "vitest";
import { Firestore } from "@google-cloud/firestore";
import { FirestoreDedupStore } from "../dedup.js";
import { FakeFirestore } from "./fake-firestore.js";

const WINDOW_MS = 10 * 60 * 1000;
const COLLECTION = "ops_notification_dedup";

describe("FirestoreDedupStore.decide", () => {
  it("新規fingerprintは投稿対象になり、ttlExpireAt等の付随フィールドも書き込む", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);

    const decision = await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");

    expect(decision).toEqual({ shouldPost: true, suppressedSincePrevious: 0 });
    const doc = await db.collection(COLLECTION).doc("fp-1").get();
    expect(doc.exists).toBe(true);
    const data = doc.data() as Record<string, unknown>;
    expect(data.suppressedCount).toBe(0);
    expect(data.needsFlush).toBe(false);
    expect(data.seenInsertIds).toEqual(["insert-1"]);
    expect(data.ttlExpireAt).toBeDefined();
  });

  it("ウィンドウ内の新規イベントはneedsFlush:trueで抑制件数を書き込む", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);

    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    const decision = await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");

    expect(decision).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });
    const doc = await db.collection(COLLECTION).doc("fp-1").get();
    const data = doc.data() as Record<string, unknown>;
    expect(data.suppressedCount).toBe(1);
    expect(data.needsFlush).toBe(true);
  });

  it("トランザクションが常に失敗する場合、リトライ上限後に個別投稿へフォールバックする", async () => {
    const alwaysFailingDb = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async () => {
        throw new Error("firestore unavailable");
      },
    } as unknown as Firestore;
    const store = new FirestoreDedupStore(alwaysFailingDb, WINDOW_MS);

    const decision = await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");

    expect(decision).toEqual({ shouldPost: true, suppressedSincePrevious: 0 });
  });
});

describe("FirestoreDedupStore.rollback", () => {
  it("他のinsertIdが残っている場合、部分マージで更新し他フィールドは不変（Partial Update検証）", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);

    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    const before = await db.collection(COLLECTION).doc("fp-1").get();
    const beforeData = before.data() as Record<string, unknown>;

    await store.rollback("fp-1", "insert-1", 0);

    const after = await db.collection(COLLECTION).doc("fp-1").get();
    const afterData = after.data() as Record<string, unknown>;
    expect(afterData.seenInsertIds).toEqual(["insert-2"]);
    // 更新対象外フィールド（windowEndsAt, needsFlush, ttlExpireAt）は不変
    expect(afterData.windowEndsAt).toBe(beforeData.windowEndsAt);
    expect(afterData.needsFlush).toBe(beforeData.needsFlush);
    expect(afterData.ttlExpireAt).toBe(beforeData.ttlExpireAt);
  });

  it("ウィンドウ境界をまたいだ直後のrollbackで直前ウィンドウの抑制件数を復元する", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);

    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    await store.decide("fp-1", "insert-3", "2026-09-02T00:02:00.000Z");
    const boundary = await store.decide("fp-1", "insert-4", "2026-09-02T00:11:00.000Z");
    expect(boundary.suppressedSincePrevious).toBe(2);

    await store.rollback("fp-1", "insert-4", boundary.suppressedSincePrevious);

    const redelivery = await store.decide("fp-1", "insert-4", "2026-09-02T00:12:00.000Z");
    expect(redelivery).toEqual({ shouldPost: true, suppressedSincePrevious: 2 });
  });

  it("存在しないfingerprintへのrollbackは例外を投げない", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);

    await expect(store.rollback("nonexistent", "insert-1", 0)).resolves.toBeUndefined();
  });
});

describe("FirestoreDedupStore.listPendingFlush / markFlushed", () => {
  it("needsFlush=true かつ windowEndsAt が過去のドキュメントのみ返す", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);

    // fp-1: ウィンドウ内で抑制されている(まだflush対象外)
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    // fp-2: 単独投稿のみ(needsFlush:false、そもそも対象外)
    await store.decide("fp-2", "insert-3", "2026-09-02T00:00:00.000Z");

    const pendingBeforeWindowEnd = await store.listPendingFlush("2026-09-02T00:05:00.000Z");
    expect(pendingBeforeWindowEnd).toEqual([]);

    const pendingAfterWindowEnd = await store.listPendingFlush("2026-09-02T00:15:00.000Z");
    expect(pendingAfterWindowEnd).toHaveLength(1);
    expect(pendingAfterWindowEnd[0]).toMatchObject({ fingerprint: "fp-1", suppressedCount: 1 });
  });

  it("markFlushedはwindowEndsAt一致時のみ削除する", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    const [pending] = await store.listPendingFlush("2026-09-02T00:15:00.000Z");

    await store.markFlushed(pending.fingerprint, pending.windowEndsAt);

    const doc = await db.collection(COLLECTION).doc("fp-1").get();
    expect(doc.exists).toBe(false);
  });

  it("markFlushed時点でwindowEndsAtが変わっていた場合は削除しない（新規イベントとの競合防止）", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreDedupStore(db.asFirestore(), WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    const [pending] = await store.listPendingFlush("2026-09-02T00:15:00.000Z");

    // flush処理中に新規イベントが到着し、新ウィンドウが始まった状況を再現
    await store.decide("fp-1", "insert-3", "2026-09-02T00:16:00.000Z");

    await store.markFlushed(pending.fingerprint, pending.windowEndsAt);

    const doc = await db.collection(COLLECTION).doc("fp-1").get();
    expect(doc.exists).toBe(true); // 新ウィンドウの状態は消えずに残る
  });
});
