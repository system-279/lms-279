"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { VideoControls } from "./VideoControls";
import { VideoEventTracker } from "./VideoEventTracker";

interface VideoPlayerProps {
  videoId: string;
  src: string;
  speedLock?: boolean;
  onComplete?: () => void;
  /** 再生開始時コールバック */
  onPlay?: () => void;
  /** 一時停止時コールバック */
  onPause?: () => void;
  /** イベント送信先エンドポイント。省略時は /api/v1/videos/:videoId/events */
  eventEndpoint?: string;
  /** 認証付きfetch関数。省略時はグローバルfetch */
  fetchFn?: (url: string, options?: RequestInit) => Promise<Response>;
}

/** crypto.randomUUID が使えない環境向けフォールバック */
function generateSessionToken(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function VideoPlayer({
  videoId,
  src,
  speedLock = true,
  onComplete,
  onPlay,
  onPause,
  eventEndpoint,
  fetchFn,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // セッショントークンはマウント時に1度だけ生成
  const sessionToken = useMemo(() => generateSessionToken(), []);

  // --- 倍速禁止（ADR-015） ---
  useEffect(() => {
    if (!speedLock) return;
    const video = videoRef.current;
    if (!video) return;
    const handleRateChange = () => {
      if (video.playbackRate !== 1.0) {
        video.playbackRate = 1.0;
      }
    };
    video.addEventListener("ratechange", handleRateChange);
    return () => {
      video.removeEventListener("ratechange", handleRateChange);
    };
  }, [speedLock]);

  // --- ビデオ状態同期 ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      setIsPlaying(true);
      onPlay?.();
    };
    const handlePause = () => {
      setIsPlaying(false);
      onPause?.();
    };
    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handleDurationChange = () => setDuration(video.duration);
    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setIsLoading(false);
    };
    const handleWaiting = () => setIsLoading(true);
    const handleCanPlay = () => setIsLoading(false);
    const handleEnded = () => {
      setIsPlaying(false);
      onComplete?.();
    };
    const handleError = () => {
      const err = video.error;
      const msg = err
        ? `動画の読み込みに失敗しました (code: ${err.code})`
        : "動画の読み込みに失敗しました";
      setError(msg);
      setIsLoading(false);
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("durationchange", handleDurationChange);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("error", handleError);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("durationchange", handleDurationChange);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("error", handleError);
    };
  }, [onComplete, onPlay, onPause]);

  // --- タブ離脱検知 ---
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        videoRef.current?.pause();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // --- コントロール自動非表示 ---
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current !== null) {
      clearTimeout(hideControlsTimerRef.current);
    }
    hideControlsTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setShowControls(false);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (hideControlsTimerRef.current !== null) {
        clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, []);

  // --- 再生/一時停止トグル ---
  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, []);

  // --- シーク ---
  const handleSeek = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
  }, []);

  return (
    <div
      className="relative w-full bg-black rounded-lg overflow-hidden select-none"
      data-video-container
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
    >
      {/* ローディングオーバーレイ */}
      {isLoading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
          <div className="size-10 rounded-full border-4 border-white/20 border-t-white animate-spin" />
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10 gap-2 px-6 text-center">
          <p className="text-white text-sm">{error}</p>
          <button
            className="mt-2 px-4 py-1.5 rounded bg-white/20 text-white text-xs hover:bg-white/30 transition-colors"
            onClick={() => {
              setError(null);
              setIsLoading(true);
              videoRef.current?.load();
            }}
          >
            再試行
          </button>
        </div>
      )}

      {/* HTML5 Video 要素 */}
      <video
        ref={videoRef}
        src={src}
        className="w-full aspect-video"
        playsInline
        preload="metadata"
        onClick={handlePlayPause}
        // ブラウザデフォルトのコントロールを非表示にしてカスタムUIを使用
        controls={false}
      />

      {/* カスタムコントロール */}
      <div
        className={`transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0"
        }`}
      >
        <VideoControls
          videoRef={videoRef}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          onPlayPause={handlePlayPause}
          onSeek={handleSeek}
        />
      </div>

      {/* イベントトラッカー（UIなし） */}
      <VideoEventTracker
        videoRef={videoRef}
        videoId={videoId}
        sessionToken={sessionToken}
        apiEndpoint={eventEndpoint ?? `/api/v1/videos/${videoId}/events`}
        fetchFn={fetchFn ?? fetch}
      />
    </div>
  );
}
