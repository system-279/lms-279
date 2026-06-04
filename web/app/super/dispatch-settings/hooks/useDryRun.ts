"use client";

/**
 * dispatch dry-run 取得 hook (Phase 4 α-7-FE、AC-α7-12 / AC-α7-13 担保)。
 *
 * 設計:
 *   - **自動連打防止**: 初回マウントで自動取得しない (明示 `refresh()` で発火)。
 *     同一 lane の実行中は重複 fetch を suppress (BE single-flight と FE dedupe の一対設計)。
 *   - **AbortController**: 同 lane 連打や unmount で前回リクエストを cancel し、stale な
 *     setState を防ぐ。
 *   - **lane-scoped state**: discriminated union `DispatchDryRunResult` を type narrowing で
 *     扱えるよう、hook ごとに 1 lane を担当 (`progress` / `completion` で別 instance)。
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク D3
 *   - AC-α7-12 (Request Control): 同 lane 連打防止
 *   - AC-α7-13 (Data Freshness): evaluatedAt を UI に渡して鮮度表示
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CompletionDryRunResult,
  DispatchLane,
  ProgressDryRunResult,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { useSuperAdminFetch } from "@/lib/super-api";

export type LaneResult<L extends DispatchLane> = L extends "progress"
  ? ProgressDryRunResult
  : CompletionDryRunResult;

export interface UseDryRunState<L extends DispatchLane> {
  result: LaneResult<L> | null;
  isLoading: boolean;
  error: ApiError | null;
  /** 直近の取得完了時刻 (FE 時計、`result.evaluatedAt` とは別。連打抑止 UX 用) */
  lastFetchedAt: string | null;
}

export interface UseDryRunReturn<L extends DispatchLane>
  extends UseDryRunState<L> {
  refresh: () => Promise<void>;
}

const LANE_TO_PATH: Record<DispatchLane, string> = {
  progress: "/api/v2/super/dispatch/dry-run/progress",
  completion: "/api/v2/super/dispatch/dry-run/completion",
};

export function useDryRun<L extends DispatchLane>(
  lane: L,
): UseDryRunReturn<L> {
  const { superFetch } = useSuperAdminFetch();
  const [state, setState] = useState<UseDryRunState<L>>({
    result: null,
    isLoading: false,
    error: null,
    lastFetchedAt: null,
  });

  // 同 lane 連打抑止: 進行中の AbortController を保持し、新規 refresh は no-op
  const abortRef = useRef<AbortController | null>(null);

  // unmount 時に進行中の fetch を abort し、stale な setState を防ぐ
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (abortRef.current) {
      // 既に進行中なら何もしない (BE single-flight + FE dedupe の一対設計)
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const result = await superFetch<LaneResult<L>>(LANE_TO_PATH[lane], {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setState({
        result,
        isLoading: false,
        error: null,
        lastFetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError(0, "network_error", "予期しないエラーが発生しました");
      setState((prev) => ({ ...prev, isLoading: false, error: apiError }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [lane, superFetch]);

  return { ...state, refresh };
}
