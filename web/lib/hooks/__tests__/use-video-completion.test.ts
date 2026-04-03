import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useVideoCompletion, type UseVideoCompletionParams } from "../use-video-completion";

const makeAnalytics = (overrides: Partial<{ isComplete: boolean; coverageRatio: number }> = {}) => ({
  analytics: {
    videoId: "v1",
    userId: "u1",
    watchedRanges: [],
    totalWatchTimeSec: 0,
    coverageRatio: overrides.coverageRatio ?? 0,
    isComplete: overrides.isComplete ?? false,
    seekCount: 0,
    pauseCount: 0,
    totalPauseDurationSec: 0,
    speedViolationCount: 0,
    suspiciousFlags: [],
  },
});

describe("useVideoCompletion", () => {
  let mockAuthFetch: ReturnType<typeof vi.fn> & UseVideoCompletionParams["authFetch"];

  beforeEach(() => {
    mockAuthFetch = vi.fn() as ReturnType<typeof vi.fn> & UseVideoCompletionParams["authFetch"];
  });

  // 1. 正常終了: isComplete=true → videoCompleted=true, showQuizSection=true
  it("sets videoCompleted=true and showQuizSection=true when isComplete=true", async () => {
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: true }));

    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta: { id: "v1" },
        hasVideo: true,
        hasQuiz: true,
      })
    );

    await waitFor(() => {
      expect(result.current.videoCompleted).toBe(true);
    });
    expect(result.current.showQuizSection).toBe(true);
    expect(result.current.analytics?.isComplete).toBe(true);
  });

  // 2. 飛ばし終了: isComplete=false → videoCompleted=false, showQuizSection=false
  it("keeps videoCompleted=false and showQuizSection=false when isComplete=false", async () => {
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: false }));

    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta: { id: "v1" },
        hasVideo: true,
        hasQuiz: true,
      })
    );

    await waitFor(() => {
      expect(result.current.loadingAnalytics).toBe(false);
    });
    expect(result.current.videoCompleted).toBe(false);
    expect(result.current.showQuizSection).toBe(false);
  });

  // 3. ページリロード: mount時のuseEffect → isComplete=true → showQuizSection=true
  it("fetches analytics on mount and shows quiz when already complete", async () => {
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: true, coverageRatio: 0.98 }));

    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta: { id: "v1" },
        hasVideo: true,
        hasQuiz: true,
      })
    );

    await waitFor(() => {
      expect(result.current.showQuizSection).toBe(true);
    });
    expect(mockAuthFetch).toHaveBeenCalledWith("/api/v1/videos/v1/analytics");
  });

  // 4. handleVideoComplete: fetchAnalytics呼び出し → isComplete反映
  it("handleVideoComplete triggers fetchAnalytics and updates state", async () => {
    // 初回fetch: 未完了
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: false }));

    const videoMeta = { id: "v1" };
    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta,
        hasVideo: true,
        hasQuiz: true,
      })
    );

    // 初回fetch完了を待つ
    await waitFor(() => {
      expect(result.current.loadingAnalytics).toBe(false);
    });
    expect(result.current.showQuizSection).toBe(false);

    // handleVideoComplete: 完了に更新
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: true }));

    act(() => {
      result.current.handleVideoComplete();
    });

    // 2回目のfetch結果が反映されるのを待つ
    await waitFor(() => {
      expect(result.current.videoCompleted).toBe(true);
    });
    expect(result.current.showQuizSection).toBe(true);
  });

  // 5. fetchAnalytics失敗 → videoCompleted=false維持
  it("keeps videoCompleted=false when fetchAnalytics fails", async () => {
    mockAuthFetch.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta: { id: "v1" },
        hasVideo: true,
        hasQuiz: true,
      })
    );

    await waitFor(() => {
      expect(result.current.loadingAnalytics).toBe(false);
    });
    expect(result.current.videoCompleted).toBe(false);
    expect(result.current.showQuizSection).toBe(false);
    expect(result.current.analytics).toBeNull();
  });

  // 6. 動画なしレッスン → showQuizSection=true
  it("shows quiz section when lesson has no video", () => {
    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta: null,
        hasVideo: false,
        hasQuiz: true,
      })
    );

    expect(result.current.showQuizSection).toBe(true);
    // 動画なしの場合fetchしない
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  // 7. テストなしレッスン → showQuizSection=false
  it("hides quiz section when lesson has no quiz", async () => {
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: true }));

    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta: { id: "v1" },
        hasVideo: true,
        hasQuiz: false,
      })
    );

    await waitFor(() => {
      expect(result.current.loadingAnalytics).toBe(false);
    });
    expect(result.current.showQuizSection).toBe(false);
  });

  // 8. fetchAnalyticsでサーバー値に追従（isComplete=false→videoCompleted=false）
  it("reverts videoCompleted when server returns isComplete=false", async () => {
    // 初回: 完了
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: true }));

    const videoMeta = { id: "v1" };
    const { result } = renderHook(() =>
      useVideoCompletion({
        authFetch: mockAuthFetch,
        videoMeta,
        hasVideo: true,
        hasQuiz: true,
      })
    );

    await waitFor(() => {
      expect(result.current.videoCompleted).toBe(true);
    });

    // 2回目: サーバーがisComplete=falseを返す（データ補正等）
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: false }));

    act(() => {
      result.current.handleVideoComplete();
    });

    await waitFor(() => {
      expect(result.current.loadingAnalytics).toBe(false);
    });

    // サーバー値に追従してvideoCompleted=falseに戻る
    expect(result.current.videoCompleted).toBe(false);
    expect(result.current.showQuizSection).toBe(false);
  });

  // 9. videoId変更時に新しいvideoIdでfetchが走る
  it("re-fetches analytics when videoId changes", async () => {
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: true }));

    const { result, rerender } = renderHook(
      (props: { videoMeta: { id: string } | null }) =>
        useVideoCompletion({
          authFetch: mockAuthFetch,
          videoMeta: props.videoMeta,
          hasVideo: true,
          hasQuiz: true,
        }),
      { initialProps: { videoMeta: { id: "v1" } } }
    );

    await waitFor(() => {
      expect(result.current.videoCompleted).toBe(true);
    });
    expect(mockAuthFetch).toHaveBeenCalledWith("/api/v1/videos/v1/analytics");

    // videoId変更 → 新しいfetch
    mockAuthFetch.mockResolvedValueOnce(makeAnalytics({ isComplete: false }));
    rerender({ videoMeta: { id: "v2" } });

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith("/api/v1/videos/v2/analytics");
    });
  });
});
