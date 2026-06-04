/**
 * dispatch-dry-run single-flight 制御の unit test (Phase 4 α-7 C1)。
 *
 * 観点:
 *   - 同一 lane の重複リクエストで結果共有 (fn 呼び出しは 1 回のみ)
 *   - lane が異なれば独立実行
 *   - 完了後は Map から削除され、次回リクエストは新規実行
 *   - reject も結果共有 (fail-fast)
 */

import { describe, it, expect, vi } from "vitest";

import { createDispatchDryRunSingleFlightForTest } from "../single-flight.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DispatchDryRunSingleFlight", () => {
  it("should execute fn only once for concurrent same-lane requests and share result", async () => {
    const sf = createDispatchDryRunSingleFlightForTest();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);

    // 同 lane に 3 リクエスト並行で投入
    const p1 = sf.run("progress", fn);
    const p2 = sf.run("progress", fn);
    const p3 = sf.run("progress", fn);

    d.resolve("result-A");
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(r1).toBe("result-A");
    expect(r2).toBe("result-A");
    expect(r3).toBe("result-A");
  });

  it("should execute independently for different lanes", async () => {
    const sf = createDispatchDryRunSingleFlightForTest();
    const progressFn = vi.fn(async () => "progress-result");
    const completionFn = vi.fn(async () => "completion-result");

    const [pr, cr] = await Promise.all([
      sf.run("progress", progressFn),
      sf.run("completion", completionFn),
    ]);

    expect(progressFn).toHaveBeenCalledTimes(1);
    expect(completionFn).toHaveBeenCalledTimes(1);
    expect(pr).toBe("progress-result");
    expect(cr).toBe("completion-result");
  });

  it("should clear inflight slot after completion (next call re-executes fn)", async () => {
    const sf = createDispatchDryRunSingleFlightForTest();
    let counter = 0;
    const fn = vi.fn(async () => {
      counter += 1;
      return `call-${counter}`;
    });

    const first = await sf.run("progress", fn);
    const second = await sf.run("progress", fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(first).toBe("call-1");
    expect(second).toBe("call-2");
  });

  it("should share rejected error to concurrent waiters", async () => {
    const sf = createDispatchDryRunSingleFlightForTest();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);

    const p1 = sf.run("progress", fn);
    const p2 = sf.run("progress", fn);

    const err = new Error("dry-run failed");
    d.reject(err);

    await expect(p1).rejects.toThrow("dry-run failed");
    await expect(p2).rejects.toThrow("dry-run failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should re-execute fn on next call after a rejection", async () => {
    const sf = createDispatchDryRunSingleFlightForTest();
    let counter = 0;
    const fn = vi.fn(async () => {
      counter += 1;
      if (counter === 1) throw new Error("first call fails");
      return `call-${counter}`;
    });

    await expect(sf.run("progress", fn)).rejects.toThrow("first call fails");
    const second = await sf.run("progress", fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(second).toBe("call-2");
  });
});
