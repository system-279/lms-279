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

  it("rollback対象のinsertIdの後に別イベントが到着していた場合は何もしない", async () => {
    const store = new InMemoryDedupStore(WINDOW_MS);
    await store.decide("fp-1", "insert-1", "2026-09-02T00:00:00.000Z");
    // 別の再配信ではない新規イベントがウィンドウ内で到着（suppressedCountが増える）
    await store.decide("fp-1", "insert-2", "2026-09-02T00:01:00.000Z");
    expect(store.size()).toBe(1);

    await store.rollback("fp-1", "insert-1");

    // 既に状態が進んでいるため削除されない
    expect(store.size()).toBe(1);
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
