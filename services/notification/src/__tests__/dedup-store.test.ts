import { describe, it, expect } from "vitest";
import { InMemoryDedupStore } from "./test-helpers.js";

const WINDOW_MS = 10 * 60 * 1000;

describe("DedupStore.rollback", () => {
  it("直後にrollbackすると、decide()による書き込みを打ち消す", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    expect(store.size()).toBe(1);

    await store.rollback("fp-1", "insert-1");

    expect(store.size()).toBe(0);
  });

  it("rollback対象のinsertIdの後に別イベントが到着していた場合、そのinsertIdだけ除去し他の状態は保つ", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    // insert-1のChat投稿がtransient失敗して滞留している間に、別の新規イベントが到着
    const second = await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    expect(second).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });

    await store.rollback("fp-1", "insert-1");

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

    await store.rollback("fp-1", "insert-1");

    expect(store.size()).toBe(0);
    // 再配信されると全くの新規fingerprintとして扱われ、即時投稿対象になる
    const redelivery = await store.decide("fp-1", "insert-1", "2026-09-02T00:02:00.000Z");
    expect(redelivery).toEqual({ shouldPost: true, suppressedSincePrevious: 0 });
  });

  it("存在しないfingerprintへのrollbackは何もしない", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await expect(store.rollback("nonexistent", "insert-1")).resolves.toBeUndefined();
  });
});

describe("DedupStore.markFlushed", () => {
  it("windowEndsAtが一致する場合のみ削除する", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    const pending = await store.listPendingFlush("2026-09-02T00:15:00.000Z");
    expect(pending).toHaveLength(1);

    await store.markFlushed(pending[0].fingerprint, pending[0].windowEndsAt);

    expect(store.size()).toBe(0);
  });

  it("listPendingFlush読み取り後に新しいウィンドウが始まっていた場合は削除しない", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    const pending = await store.listPendingFlush("2026-09-02T00:15:00.000Z");

    // flush処理中に新規イベントが到着し、新ウィンドウが始まった状況を再現
    await store.decide("fp-1", "insert-3", "2026-09-02T00:16:00.000Z");

    await store.markFlushed(pending[0].fingerprint, pending[0].windowEndsAt);

    // 新ウィンドウの状態は消えずに残る
    expect(store.size()).toBe(1);
  });
});
