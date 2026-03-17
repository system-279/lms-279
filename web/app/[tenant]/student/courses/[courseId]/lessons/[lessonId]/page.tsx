"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { VideoPlayer } from "@/components/video/VideoPlayer";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";

// ============================================================
// 型定義
// ============================================================

type Lesson = {
  id: string;
  courseId: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
  videoUnlocksPrior: boolean;
};

type Course = {
  id: string;
  name: string;
  description: string;
  status: string;
  passThreshold: number;
};

type VideoMeta = {
  id: string;
  lessonId: string;
  durationSec: number;
  requiredWatchRatio: number;
  speedLock: boolean;
};

type PlaybackData = {
  playbackUrl: string;
  video: {
    id: string;
    durationSec: number;
    requiredWatchRatio: number;
    speedLock: boolean;
  };
};

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

// ============================================================
// ページコンポーネント
// ============================================================

export default function StudentLessonDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const lessonId = params.lessonId as string;
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  /**
   * VideoEventTracker の fetchFn シグネチャ (url, options?) => Promise<Response> に合わせるラッパー。
   * authFetch は JSON をパースして T を返すため、イベント送信専用に Response 互換オブジェクトを返す。
   */
  const eventFetchFn = useCallback(
    async (url: string, options?: RequestInit): Promise<Response> => {
      await authFetch<unknown>(url, options);
      // VideoEventTracker は Response の内容を使わないため、ok:true の最小 Response を返す
      return new Response(null, { status: 200 });
    },
    [authFetch]
  );

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [currentLesson, setCurrentLesson] = useState<Lesson | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const [loadingCourse, setLoadingCourse] = useState(true);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  // ============================================================
  // コース・レッスン一覧取得
  // ============================================================

  const fetchCourse = useCallback(async () => {
    setLoadingCourse(true);
    setError(null);
    try {
      const data = await authFetch<{ course: Course; lessons: Lesson[] }>(
        `/api/v1/courses/${courseId}`
      );
      setCourse(data.course);
      const sorted = [...data.lessons].sort((a, b) => a.order - b.order);
      setLessons(sorted);
      const found = sorted.find((l) => l.id === lessonId) ?? null;
      setCurrentLesson(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "講座情報の取得に失敗しました");
    } finally {
      setLoadingCourse(false);
    }
  }, [authFetch, courseId, lessonId]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse]);

  // ============================================================
  // 動画メタデータ・再生URL取得
  // ============================================================

  const fetchVideoData = useCallback(async () => {
    if (!currentLesson?.hasVideo) return;
    setLoadingVideo(true);
    setVideoError(null);
    try {
      // 1. レッスンに紐づく動画IDを取得
      const metaData = await authFetch<{ video: VideoMeta }>(
        `/api/v1/lessons/${lessonId}/video`
      );
      setVideoMeta(metaData.video);

      // 2. 署名付き再生URLを取得
      const playbackData = await authFetch<PlaybackData>(
        `/api/v1/videos/${metaData.video.id}/playback-url`
      );
      setPlaybackUrl(playbackData.playbackUrl);
    } catch (e) {
      setVideoError(e instanceof Error ? e.message : "動画情報の取得に失敗しました");
    } finally {
      setLoadingVideo(false);
    }
  }, [authFetch, currentLesson, lessonId]);

  useEffect(() => {
    if (currentLesson) {
      fetchVideoData();
    }
  }, [currentLesson, fetchVideoData]);

  // ============================================================
  // 視聴分析取得
  // ============================================================

  const fetchAnalytics = useCallback(async () => {
    if (!videoMeta) return;
    setLoadingAnalytics(true);
    try {
      const data = await authFetch<{ analytics: Analytics }>(
        `/api/v1/videos/${videoMeta.id}/analytics`
      );
      setAnalytics(data.analytics);
    } catch {
      // 分析取得失敗はサイレント（メイン機能ではない）
    } finally {
      setLoadingAnalytics(false);
    }
  }, [authFetch, videoMeta]);

  useEffect(() => {
    if (videoMeta) {
      fetchAnalytics();
    }
  }, [videoMeta, fetchAnalytics]);

  // ============================================================
  // ナビゲーション（前後レッスン）
  // ============================================================

  const currentIndex = lessons.findIndex((l) => l.id === lessonId);
  const prevLesson = currentIndex > 0 ? lessons[currentIndex - 1] : null;
  const nextLesson = currentIndex >= 0 && currentIndex < lessons.length - 1
    ? lessons[currentIndex + 1]
    : null;

  // ============================================================
  // 視聴進捗
  // ============================================================

  const coveragePercent = analytics
    ? Math.round(analytics.coverageRatio * 100)
    : 0;

  // ============================================================
  // レンダリング
  // ============================================================

  if (loadingCourse) {
    return (
      <div className="space-y-6">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
        <Link
          href={`/${tenantId}/student/courses/${courseId}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← コースに戻る
        </Link>
      </div>
    );
  }

  if (!currentLesson) {
    return (
      <div className="space-y-6">
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          レッスンが見つかりません
        </div>
        <Link
          href={`/${tenantId}/student/courses/${courseId}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← コースに戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* パンくずリスト */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href={`/${tenantId}/student/courses`}
          className="hover:text-foreground"
        >
          講座一覧
        </Link>
        <span>/</span>
        <Link
          href={`/${tenantId}/student/courses/${courseId}`}
          className="hover:text-foreground"
        >
          {course?.name ?? "..."}
        </Link>
        <span>/</span>
        <span className="text-foreground">{currentLesson.title}</span>
      </div>

      {/* レッスンタイトル */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{currentLesson.title}</h1>
      </div>

      {/* 動画セクション */}
      <div className="space-y-4">
        {currentLesson.hasVideo ? (
          <>
            {loadingVideo && (
              <div className="w-full aspect-video bg-black/5 rounded-lg flex items-center justify-center text-muted-foreground">
                動画を読み込み中...
              </div>
            )}

            {videoError && (
              <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
                {videoError}
              </div>
            )}

            {!loadingVideo && !videoError && playbackUrl && videoMeta && (
              <>
                <VideoPlayer
                  videoId={videoMeta.id}
                  src={playbackUrl}
                  speedLock={videoMeta.speedLock}
                  eventEndpoint={`/api/v2/${tenantId}/videos/${videoMeta.id}/events`}
                  fetchFn={eventFetchFn}
                  onComplete={fetchAnalytics}
                />

                {/* 視聴進捗 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">視聴進捗</span>
                    <div className="flex items-center gap-2">
                      {analytics?.isComplete && (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-600 text-white">
                          視聴完了
                        </Badge>
                      )}
                      {!loadingAnalytics && (
                        <span className="font-medium">{coveragePercent}%</span>
                      )}
                    </div>
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-primary h-2 rounded-full transition-all duration-500"
                      style={{ width: `${coveragePercent}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="rounded-md border p-8 text-center text-muted-foreground">
            このレッスンには動画がありません
          </div>
        )}
      </div>

      {/* クイズセクション */}
      {currentLesson.hasQuiz && (
        <div className="rounded-md border p-6 space-y-2">
          <h2 className="text-lg font-semibold">クイズ</h2>
          <p className="text-sm text-muted-foreground">
            Phase 3で実装予定
          </p>
        </div>
      )}

      {/* ナビゲーション */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div>
          {prevLesson ? (
            <Link
              href={`/${tenantId}/student/courses/${courseId}/lessons/${prevLesson.id}`}
              className="flex flex-col gap-0.5 text-sm hover:text-foreground text-muted-foreground"
            >
              <span className="text-xs">前のレッスン</span>
              <span className="font-medium">← {prevLesson.title}</span>
            </Link>
          ) : (
            <Link
              href={`/${tenantId}/student/courses/${courseId}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← コースに戻る
            </Link>
          )}
        </div>

        <div className="text-right">
          {nextLesson && (
            <Link
              href={`/${tenantId}/student/courses/${courseId}/lessons/${nextLesson.id}`}
              className="flex flex-col gap-0.5 text-sm hover:text-foreground text-muted-foreground items-end"
            >
              <span className="text-xs">次のレッスン</span>
              <span className="font-medium">{nextLesson.title} →</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
