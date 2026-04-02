"use client";

import { useState, useCallback, useEffect } from "react";

type Analytics = {
  videoId: string;
  userId: string;
  watchedRanges: { start: number; end: number }[];
  totalWatchTimeSec: number;
  coverageRatio: number;
  isComplete: boolean;
  seekCount: number;
  pauseCount: number;
  totalPauseDurationSec: number;
  speedViolationCount: number;
  suspiciousFlags: string[];
  updatedAt?: string;
};

type UseVideoCompletionParams = {
  authFetch: <T>(url: string, options?: RequestInit) => Promise<T>;
  videoMeta: { id: string } | null;
  hasVideo: boolean;
  hasQuiz: boolean;
};

type UseVideoCompletionReturn = {
  analytics: Analytics | null;
  videoCompleted: boolean;
  loadingAnalytics: boolean;
  showQuizSection: boolean;
  fetchAnalytics: () => Promise<void>;
  handleVideoComplete: () => Promise<void>;
};

export function useVideoCompletion({
  authFetch,
  videoMeta,
  hasVideo,
  hasQuiz,
}: UseVideoCompletionParams): UseVideoCompletionReturn {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [videoCompleted, setVideoCompleted] = useState(false);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const videoId = videoMeta?.id ?? null;

  const fetchAnalytics = useCallback(async () => {
    if (!videoId) return;
    setLoadingAnalytics(true);
    try {
      const data = await authFetch<{ analytics: Analytics }>(
        `/api/v1/videos/${videoId}/analytics`
      );
      setAnalytics(data.analytics);
      if (data.analytics.isComplete) {
        setVideoCompleted(true);
      }
    } catch {
      // 分析取得失敗はサイレント（メイン機能ではない）
    } finally {
      setLoadingAnalytics(false);
    }
  }, [authFetch, videoId]);

  useEffect(() => {
    if (videoId) {
      fetchAnalytics();
    }
  }, [videoId, fetchAnalytics]);

  const handleVideoComplete = useCallback(async () => {
    await fetchAnalytics();
  }, [fetchAnalytics]);

  const showQuizSection =
    hasQuiz && (!hasVideo || videoCompleted || analytics?.isComplete === true);

  return {
    analytics,
    videoCompleted,
    loadingAnalytics,
    showQuizSection,
    fetchAnalytics,
    handleVideoComplete,
  };
}

export type { Analytics, UseVideoCompletionParams, UseVideoCompletionReturn };
