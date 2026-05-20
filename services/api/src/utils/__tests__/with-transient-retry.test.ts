/**
 * Issue #425: withTransientRetry の単体テスト。
 *
 * テスト観点 (AC-1 transient / permanent / max retries / 成功):
 * - 初回成功時はリトライしない
 * - transient エラー (UNAVAILABLE / DEADLINE_EXCEEDED / ABORTED / INTERNAL) でリトライ
 * - permanent エラー (NOT_FOUND など) は即 throw
 * - maxAttempts 超過で最後のエラーを throw
 * - 数値形式 / 文字列形式の両方の grpc code を扱える
 * - logger.warn が retry 毎に呼ばれる
 * - context が logger payload に渡される
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTransientRetry } from "../with-transient-retry.js";
import { logger } from "../logger.js";

// 実時間 retry で baseDelayMs=1 を使い、テスト総時間を ~ms に抑える。
// vi.useFakeTimers は Promise rejection の伝搬と timer 進行の組み合わせで
// unhandled rejection を引き起こしやすいため避ける。
const OPTS = { baseDelayMs: 1 } as const;

describe("withTransientRetry (Issue #425)", () => {
  let loggerWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it("AC-1 (成功): 初回で成功 → そのまま値を返す、retry なし、logger.warn なし", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withTransientRetry(fn, OPTS);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it("AC-1 (transient): UNAVAILABLE (code=14) で 2 回失敗後 3 回目で成功 → retry 2 回", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unavail-1"), { code: 14 }))
      .mockRejectedValueOnce(Object.assign(new Error("unavail-2"), { code: 14 }))
      .mockResolvedValueOnce("success");

    const result = await withTransientRetry(fn, OPTS);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(2);
    const firstWarnCall = loggerWarnSpy.mock.calls[0];
    expect(firstWarnCall[0]).toBe("withTransientRetry: retrying");
    const firstPayload = firstWarnCall[1] as Record<string, unknown>;
    expect(firstPayload.errorType).toBe("transient_retry");
    expect(firstPayload.attempt).toBe(1);
    expect(firstPayload.grpcCode).toBe(14);
  });

  it("AC-1 (permanent): NOT_FOUND (code=5) は即 throw、retry なし", async () => {
    const permanentErr = Object.assign(new Error("not found"), { code: 5 });
    const fn = vi.fn().mockRejectedValue(permanentErr);

    await expect(withTransientRetry(fn, OPTS)).rejects.toBe(permanentErr);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it("AC-1 (max retries): transient で連続失敗 → maxAttempts 試行後に最後のエラーを throw", async () => {
    const transientErrs = [
      Object.assign(new Error("err-1"), { code: 14 }),
      Object.assign(new Error("err-2"), { code: 14 }),
      Object.assign(new Error("err-3-final"), { code: 14 }),
    ];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErrs[0])
      .mockRejectedValueOnce(transientErrs[1])
      .mockRejectedValueOnce(transientErrs[2]);

    await expect(withTransientRetry(fn, OPTS)).rejects.toBe(transientErrs[2]);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(2);
  });

  it("文字列形式の grpc code (例: 'unavailable') も transient として扱う", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unavail-str"), { code: "unavailable" }))
      .mockResolvedValueOnce("ok");

    const result = await withTransientRetry(fn, OPTS);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
  });

  it("DEADLINE_EXCEEDED (code=4) / ABORTED (code=10) / INTERNAL (code=13) も transient", async () => {
    for (const code of [4, 10, 13]) {
      loggerWarnSpy.mockClear();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error(`code-${code}`), { code }))
        .mockResolvedValueOnce(`ok-${code}`);

      const result = await withTransientRetry(fn, OPTS);
      expect(result).toBe(`ok-${code}`);
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("maxAttempts オプションを指定すると試行回数が変わる", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("err-1"), { code: 14 }))
      .mockRejectedValueOnce(Object.assign(new Error("err-2-final"), { code: 14 }));

    await expect(
      withTransientRetry(fn, { ...OPTS, maxAttempts: 2 }),
    ).rejects.toMatchObject({ message: "err-2-final" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("baseDelayMs オプションで待機時間を制御できる (exponential backoff: base * 2^attempt)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("err-1"), { code: 14 }))
      .mockRejectedValueOnce(Object.assign(new Error("err-2"), { code: 14 }))
      .mockResolvedValueOnce("ok");

    await withTransientRetry(fn, { baseDelayMs: 5 });

    const warnCalls = loggerWarnSpy.mock.calls;
    expect(warnCalls).toHaveLength(2);
    // 1 回目 (attempt=0 → 1): base * 2^0 = 5ms
    expect((warnCalls[0][1] as Record<string, unknown>).delay).toBe(5);
    // 2 回目 (attempt=1 → 2): base * 2^1 = 10ms
    expect((warnCalls[1][1] as Record<string, unknown>).delay).toBe(10);
  });

  it("context オプションが logger.warn payload に展開される (運用追跡用)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("err"), { code: 14 }))
      .mockResolvedValueOnce("ok");

    await withTransientRetry(fn, {
      ...OPTS,
      context: { operation: "test_op", userId: "u1", tenantId: "t1" },
    });

    const payload = loggerWarnSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.operation).toBe("test_op");
    expect(payload.userId).toBe("u1");
    expect(payload.tenantId).toBe("t1");
  });

  it("code 不在のエラーは permanent 扱いで即 throw", async () => {
    const errWithoutCode = new Error("no code");
    const fn = vi.fn().mockRejectedValue(errWithoutCode);

    await expect(withTransientRetry(fn, OPTS)).rejects.toBe(errWithoutCode);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });
});
