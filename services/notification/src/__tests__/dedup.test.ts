import { describe, it, expect } from "vitest";
import { decideDedup, type DedupDocState } from "../dedup.js";

const WINDOW_MS = 10 * 60 * 1000; // 10分
const T0 = "2026-09-02T00:00:00.000Z";

describe("decideDedup", () => {
  it("新規fingerprint（doc無し）は投稿し、新ウィンドウを開始する", () => {
    const { decision, nextState } = decideDedup(undefined, "insert-1", T0, WINDOW_MS);
    expect(decision).toEqual({ shouldPost: true, suppressedSincePrevious: 0 });
    expect(nextState.suppressedCount).toBe(0);
    expect(nextState.seenInsertIds).toEqual(["insert-1"]);
    expect(new Date(nextState.windowEndsAt).getTime() - new Date(T0).getTime()).toBe(WINDOW_MS);
  });

  it("ウィンドウ内の新規イベントは投稿せず抑制件数を増やす", () => {
    const doc: DedupDocState = {
      suppressedCount: 2,
      windowEndsAt: "2026-09-02T00:10:00.000Z",
      seenInsertIds: ["insert-1"],
    };
    const nowWithinWindow = "2026-09-02T00:05:00.000Z";
    const { decision, nextState } = decideDedup(doc, "insert-2", nowWithinWindow, WINDOW_MS);
    expect(decision).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });
    expect(nextState.suppressedCount).toBe(3);
    expect(nextState.seenInsertIds).toEqual(["insert-1", "insert-2"]);
    // ウィンドウ終了時刻は据え置き
    expect(nextState.windowEndsAt).toBe(doc.windowEndsAt);
  });

  it("同一insertIdの再配信（at-least-once）は状態を変えず、抑制件数も増やさない", () => {
    const doc: DedupDocState = {
      suppressedCount: 2,
      windowEndsAt: "2026-09-02T00:10:00.000Z",
      seenInsertIds: ["insert-1", "insert-2"],
    };
    const { decision, nextState } = decideDedup(doc, "insert-2", "2026-09-02T00:05:00.000Z", WINDOW_MS);
    expect(decision).toEqual({ shouldPost: false, suppressedSincePrevious: 0 });
    expect(nextState).toEqual(doc);
  });

  it("ウィンドウ終了ちょうど（now == windowEndsAt）は「ウィンドウ外」扱いで投稿する", () => {
    const doc: DedupDocState = {
      suppressedCount: 5,
      windowEndsAt: "2026-09-02T00:10:00.000Z",
      seenInsertIds: ["insert-1"],
    };
    const { decision } = decideDedup(doc, "insert-2", "2026-09-02T00:10:00.000Z", WINDOW_MS);
    expect(decision).toEqual({ shouldPost: true, suppressedSincePrevious: 5 });
  });

  it("ウィンドウ外の新規イベントは投稿し、直前ウィンドウの抑制件数を添えて新ウィンドウを開始する", () => {
    const doc: DedupDocState = {
      suppressedCount: 7,
      windowEndsAt: "2026-09-02T00:10:00.000Z",
      seenInsertIds: ["insert-1", "insert-2"],
    };
    const nowAfterWindow = "2026-09-02T00:15:00.000Z";
    const { decision, nextState } = decideDedup(doc, "insert-3", nowAfterWindow, WINDOW_MS);
    expect(decision).toEqual({ shouldPost: true, suppressedSincePrevious: 7 });
    expect(nextState.suppressedCount).toBe(0);
    expect(nextState.seenInsertIds).toEqual(["insert-3"]);
    expect(new Date(nextState.windowEndsAt).getTime() - new Date(nowAfterWindow).getTime()).toBe(
      WINDOW_MS
    );
  });

  it("seenInsertIdsは直近20件に切り詰められる", () => {
    const seenInsertIds = Array.from({ length: 20 }, (_, i) => `insert-${i}`);
    const doc: DedupDocState = {
      suppressedCount: 20,
      windowEndsAt: "2026-09-02T00:10:00.000Z",
      seenInsertIds,
    };
    const { nextState } = decideDedup(doc, "insert-new", "2026-09-02T00:05:00.000Z", WINDOW_MS);
    expect(nextState.seenInsertIds).toHaveLength(20);
    expect(nextState.seenInsertIds[0]).toBe("insert-1"); // 先頭(insert-0)が押し出される
    expect(nextState.seenInsertIds.at(-1)).toBe("insert-new");
  });
});
