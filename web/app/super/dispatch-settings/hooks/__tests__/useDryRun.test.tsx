/**
 * useDryRun hook 単独 test (Phase 4 α-7-FE、OQ #17 #11 + AC-α7-12 UI 部分)。
 *
 * テスト対象 (impl-plan: /Users/yyyhhh/.claude/plans/silly-puzzling-moore.md T1):
 *   - T1-1: 初回マウント時に自動 fetch しない (AC-α7-12 連打防止の起点)
 *   - T1-2: refresh() 呼出で fetch 開始、成功時 state 更新 + lastFetchedAt set
 *   - T1-3: in-flight 中 unmount で AbortController.abort 発火、unhandled rejection なし
 *   - T1-4: AbortError (DOMException) は error=null で silently swallow (CRIT-1 反映)
 *   - 追加: in-flight 中の 2nd refresh() は dedupe (console.debug + no-op、CRIT-2 反映)
 *   - 追加: reset() で進行中 abort + state 初期化
 *   - 追加: ApiError 以外の通信エラーは ApiError(0, "network_error") に wrap + console.error
 *
 * 関連:
 *   - hook: ../useDryRun.ts
 *   - 設計仕様書: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §5 AC-α7-12
 *   - 集約 Issue: #521 (OQ #17)
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressDryRunResult } from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { useDryRun } from "../useDryRun";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  superFetchMock.mockReset();
  consoleDebugSpy.mockClear();
  consoleErrorSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function progressResult(
  overrides: Partial<ProgressDryRunResult> = {},
): ProgressDryRunResult {
  return {
    lane: "progress",
    evaluatedAt: "2026-06-04T15:00:00.000Z",
    settingsLoaded: true,
    settingsSnapshot: {
      progressReportEnabled: true,
      scheduleDaysOfWeek: [1],
      scheduleHourJst: 9,
      signatureName: "Test",
    },
    tenantsScanned: 1,
    tenantsSummary: [],
    totalWouldSendCount: 0,
    totalCcCount: 0,
    estimatedDurationMs: 0,
    estimatedPdfSizeKbRange: { min: 150, typical: 350, max: 1200 },
    scaleTriggerExceeded: false,
    ...overrides,
  };
}

describe("useDryRun (Phase 4 α-7 OQ #17 #11 + AC-α7-12)", () => {
  it("T1-1: 初回マウント時に自動 fetch しない (AC-α7-12 連打防止の起点)", () => {
    const { result } = renderHook(() => useDryRun("progress"));

    expect(superFetchMock).not.toHaveBeenCalled();
    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetchedAt).toBeNull();
  });

  it("T1-2: refresh() で fetch 開始、成功時に state 更新 + lastFetchedAt set", async () => {
    const fetched = progressResult({ totalWouldSendCount: 3 });
    superFetchMock.mockResolvedValueOnce(fetched);

    const { result } = renderHook(() => useDryRun("progress"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(superFetchMock).toHaveBeenCalledTimes(1);
    expect(superFetchMock).toHaveBeenCalledWith(
      "/api/v2/super/dispatch/dry-run/progress",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.result).toEqual(fetched);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetchedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("T1-3: in-flight 中 unmount で AbortController.abort 発火、unhandled rejection なし", async () => {
    // refresh() の Promise を解決しないまま unmount するため、abort signal が
    // fetch 側に届くまで pending な Promise を返す。
    let abortSignal: AbortSignal | undefined;
    superFetchMock.mockImplementationOnce(
      (_path: string, init: { signal: AbortSignal }) => {
        abortSignal = init.signal;
        return new Promise(() => {
          /* never resolves; abort で cleanup される */
        });
      },
    );

    const { result, unmount } = renderHook(() => useDryRun("progress"));

    act(() => {
      void result.current.refresh();
    });

    // unmount cleanup で abortRef.current?.abort() が走る
    unmount();

    expect(abortSignal?.aborted).toBe(true);
  });

  it("T1-4: AbortError (DOMException) は error=null で silently swallow (CRIT-1)", async () => {
    superFetchMock.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );

    const { result } = renderHook(() => useDryRun("progress"));

    await act(async () => {
      await result.current.refresh();
    });

    // signal.aborted=false でも DOMException AbortError は早期 return で
    // state を変更しない (CRIT-1: network_error と混同しない)
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("in-flight 中の 2nd refresh() は dedupe (console.debug + no-op、CRIT-2)", async () => {
    let resolveFirst: ((value: ProgressDryRunResult) => void) | undefined;
    superFetchMock.mockImplementationOnce(
      () =>
        new Promise<ProgressDryRunResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { result } = renderHook(() => useDryRun("progress"));

    // 1st refresh() は in-flight 状態のまま放置
    act(() => {
      void result.current.refresh();
    });

    // 2nd refresh() は dedupe される (superFetch 呼出回数増えない)
    await act(async () => {
      await result.current.refresh();
    });

    expect(superFetchMock).toHaveBeenCalledTimes(1);
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[useDryRun] refresh skipped, in-flight",
      { lane: "progress" },
    );

    // cleanup: 1st refresh() を完了させて in-flight 解除
    await act(async () => {
      resolveFirst?.(progressResult());
      await Promise.resolve();
    });
  });

  it("reset() で in-flight abort + state 初期化", async () => {
    // 完了した refresh() で state を埋めてから reset を確認
    const fetched = progressResult({ totalWouldSendCount: 7 });
    superFetchMock.mockResolvedValueOnce(fetched);

    const { result } = renderHook(() => useDryRun("progress"));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.result).not.toBeNull();
    expect(result.current.lastFetchedAt).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetchedAt).toBeNull();
  });

  it("ApiError 以外の通信エラーは ApiError(0, network_error) に wrap + console.error", async () => {
    const unknownError = new TypeError("Failed to fetch");
    superFetchMock.mockRejectedValueOnce(unknownError);

    const { result } = renderHook(() => useDryRun("progress"));

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.status).toBe(0);
    expect(result.current.error?.code).toBe("network_error");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[useDryRun] unexpected error",
      expect.objectContaining({ lane: "progress", err: unknownError }),
    );
  });

  it("ApiError は wrap せずそのまま state.error に格納", async () => {
    const apiError = new ApiError(429, "rate_limited", "Too many requests");
    superFetchMock.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() => useDryRun("progress"));

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.error).toBe(apiError);
    });
    // ApiError は console.error で wrap log されない (元情報が既に明示的)
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("completion lane 指定時に completion endpoint を叩く", async () => {
    superFetchMock.mockResolvedValueOnce({
      lane: "completion",
      evaluatedAt: "2026-06-04T15:00:00.000Z",
      settingsLoaded: true,
      settingsSnapshot: {
        enabled: false,
        scheduleDaysOfWeek: [1],
        scheduleHourJst: 9,
        signatureName: "Test",
        completionMessageBodyLength: 49,
      },
      tenantsScanned: 0,
      tenantsSummary: [],
      wouldNotifyCount: 0,
      wouldNotify: [],
    });

    const { result } = renderHook(() => useDryRun("completion"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(superFetchMock).toHaveBeenCalledWith(
      "/api/v2/super/dispatch/dry-run/completion",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
