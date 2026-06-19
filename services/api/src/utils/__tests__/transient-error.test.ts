/**
 * transient-error util のテスト
 *
 * 本番障害 2026-06-19: IAM Credentials API signBlob が `Premature close` で失敗 →
 * lesson-resource.ts の旧 withGcsErrorMapping が捕捉せず Express errorHandler に到達
 * → FE で `[object Object]` 表示。本テストは Premature close 等の transient
 * 判定とリトライ挙動を保証する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTransientError, retryOnTransient, TRANSIENT_NETWORK_CODES } from "../transient-error.js";

describe("isTransientError", () => {
  it("transport code ECONNRESET を transient と判定", () => {
    expect(isTransientError({ code: "ECONNRESET", message: "" })).toBe(true);
  });

  it("cause.code ETIMEDOUT を transient と判定", () => {
    expect(isTransientError({ cause: { code: "ETIMEDOUT" } })).toBe(true);
  });

  it("HTTP 503 / 429 / 504 を transient と判定", () => {
    expect(isTransientError({ response: { status: 503 } })).toBe(true);
    expect(isTransientError({ response: { status: 429 } })).toBe(true);
    expect(isTransientError({ response: { status: 504 } })).toBe(true);
  });

  it("HTTP 400 / 404 / 403 を permanent と判定", () => {
    expect(isTransientError({ response: { status: 400 } })).toBe(false);
    expect(isTransientError({ response: { status: 404 } })).toBe(false);
    expect(isTransientError({ response: { status: 403 } })).toBe(false);
  });

  it("message 'Premature close' を transient と判定 (本番障害再現)", () => {
    const err = new Error(
      "Invalid response body while trying to fetch https://iamcredentials.googleapis.com/...:signBlob: Premature close",
    );
    expect(isTransientError(err)).toBe(true);
  });

  it("message 'socket hang up' を transient と判定", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  it("cause.message が Premature close でも transient と判定", () => {
    const err = new Error("upstream failed");
    (err as { cause?: unknown }).cause = { message: "Premature close" };
    expect(isTransientError(err)).toBe(true);
  });

  it("無関係の Error は permanent と判定", () => {
    expect(isTransientError(new Error("invalid argument"))).toBe(false);
  });

  it("null / undefined / プリミティブは permanent と判定", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });

  it("TRANSIENT_NETWORK_CODES に主要 transport code が含まれる", () => {
    expect(TRANSIENT_NETWORK_CODES.has("ECONNRESET")).toBe(true);
    expect(TRANSIENT_NETWORK_CODES.has("ETIMEDOUT")).toBe(true);
    expect(TRANSIENT_NETWORK_CODES.has("ENOTFOUND")).toBe(true);
    expect(TRANSIENT_NETWORK_CODES.has("EAI_AGAIN")).toBe(true);
  });
});

describe("retryOnTransient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jitter を確定値に固定 (factor 1.0 相当)
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("初回成功時はリトライしない", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const result = await retryOnTransient(op);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("Premature close で 1 回リトライして成功 (本番障害復旧シナリオ)", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("Premature close"))
      .mockResolvedValueOnce("ok");
    const promise = retryOnTransient(op, { maxAttempts: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("maxAttempts 使い切ったら最後の例外を throw", async () => {
    const finalErr = new Error("Premature close");
    const op = vi.fn(() => Promise.reject(finalErr));
    const promise = retryOnTransient(op, { maxAttempts: 2, baseDelayMs: 100 });
    // unhandled rejection 警告を避けるため先に rejects アサーションを attach
    const assertion = expect(promise).rejects.toBe(finalErr);
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("permanent エラーは即時 throw (リトライしない)", async () => {
    const err = new Error("invalid argument");
    const op = vi.fn().mockRejectedValue(err);
    await expect(retryOnTransient(op, { maxAttempts: 3 })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("onRetry observer が delayMs / attempt 情報を受け取る", async () => {
    const onRetry = vi.fn();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("Premature close"))
      .mockResolvedValueOnce("ok");
    const promise = retryOnTransient(op, { maxAttempts: 2, baseDelayMs: 100, onRetry });
    await vi.runAllTimersAsync();
    await promise;
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      delayMs: expect.any(Number),
    });
  });
});
