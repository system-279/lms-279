/**
 * InMemoryDedupStore（テスト専用フェイク、DedupStore決定ロジックのdecideDedup部分は
 * dedup.tsのpure関数を共有するが、rollback/markFlushed/listPendingFlushは独自実装）
 * を対象にしたテスト。FirestoreDedupStore（本番実装）は
 * firestore-dedup-store.test.ts で別途直接検証する。
 */
import { describe, it, expect } from "vitest";
import { InMemoryDedupStore } from "./test-helpers.js";

const WINDOW_MS = 10 * 60 * 1000;

describe("DedupStore.rollback", () => {
  it("直後にrollbackすると、decide()による書き込みを打ち消す", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    expect(store.size()).toBe(1);

    await store.rollback("fp-1", "insert-1", 0);

    expect(store.size()).toBe(0);
  });

  it("rollback対象のinsertIdの後に別イベントが到着していた場合、そのinsertIdだけ除去し他の状態は保つ", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    // insert-1のChat投稿がtransient失敗して滞留している間に、別の新規イベントが到着
    const second = await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    expect(second).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });

    await store.rollback("fp-1", "insert-1", 0);

    // ドキュメント自体は残る（insert-2の抑制カウントを失わない）
    expect(store.size()).toBe(1);
    // insert-1は再配信されると「新規イベント」として再判定される
    // （ウィンドウは既にinsert-2で開始済みのため、抑制カウントとして扱われる。
    // 個別の詳細投稿は保証されないが、通知の存在自体は失われない）
    const redelivery = await store.decide("fp-1", "insert-1", "2026-09-02T00:02:00.000Z");
    expect(redelivery).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });
  });

  it("rollback対象がwindowの唯一のinsertIdだった場合はdocごと削除する", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");

    await store.rollback("fp-1", "insert-1", 0);

    expect(store.size()).toBe(0);
    // 再配信されると全くの新規fingerprintとして扱われ、即時投稿対象になる
    const redelivery = await store.decide("fp-1", "insert-1", "2026-09-02T00:02:00.000Z");
    expect(redelivery).toEqual({ shouldPost: true, suppressedSincePrevious: 0 });
  });

  it("存在しないfingerprintへのrollbackは何もしない", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await expect(store.rollback("nonexistent", "insert-1", 0)).resolves.toBeUndefined();
  });

  // pr-review-toolkit silent-failure-hunter 指摘（CRITICAL）: ウィンドウ境界を
  // またいだ直後のrollbackで、直前ウィンドウの抑制件数が完全に消失するバグへの回帰テスト。
  describe("ウィンドウ境界をまたいだ直後のrollback（抑制件数の復元）", () => {
    it("唯一のinsertIdだった場合、直前ウィンドウの抑制件数を復元し次のイベントで正しく報告される", async () => {
      const store = new InMemoryDedupStore(WINDOW_MS);
      // Window 1: insert-1投稿 → insert-2, insert-3抑制(suppressedCount=2)
      await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
      await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
      await store.decide("fp-1", "insert-3", "2026-09-02T00:02:00.000Z");

      // Window 1終了後、insert-4がロールオーバーとして投稿対象になる
      const boundary = await store.decide("fp-1", "insert-4", "2026-09-02T00:11:00.000Z");
      expect(boundary).toEqual({ shouldPost: true, suppressedSincePrevious: 2 });

      // insert-4のChat投稿がtransient失敗 → suppressedSincePrevious(2)を渡してrollback
      await store.rollback("fp-1", "insert-4", boundary.suppressedSincePrevious);

      // 直前ウィンドウの抑制件数(2件)を失わずに保持していること
      expect(store.size()).toBe(1);

      // insert-4の再配信（Pub/Subの再送）で、正しく2件抑制を引き継いで投稿される
      const redelivery = await store.decide("fp-1", "insert-4", "2026-09-02T00:12:00.000Z");
      expect(redelivery).toEqual({ shouldPost: true, suppressedSincePrevious: 2 });
    });

    it("rollback対象の後に別イベントが到着していた場合も、抑制件数を合算して保持する", async () => {
      const store = new InMemoryDedupStore(WINDOW_MS);
      await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
      await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
      const boundary = await store.decide("fp-1", "insert-3", "2026-09-02T00:11:00.000Z");
      expect(boundary).toEqual({ shouldPost: true, suppressedSincePrevious: 1 });

      // insert-3のChat投稿が滞留している間に、新ウィンドウ内でinsert-4が到着（抑制）
      const withinNewWindow = await store.decide("fp-1", "insert-4", "2026-09-02T00:12:00.000Z");
      expect(withinNewWindow).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });

      await store.rollback("fp-1", "insert-3", boundary.suppressedSincePrevious);

      // insert-4分(1件)とrollbackで復元した直前ウィンドウ分(1件)が合算され、
      // どちらも失われない
      const flushed = await store.listPendingFlush("2026-09-02T00:30:00.000Z");
      const entry = flushed.find((f) => f.fingerprint === "fp-1");
      expect(entry?.suppressedCount).toBe(2);
    });
  });
});