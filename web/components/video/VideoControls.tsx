"use client";

import { useState, useCallback } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize } from "lucide-react";

interface VideoControlsProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "00:00";
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function VideoControls({
  videoRef,
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
}: VideoControlsProps) {
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const progressPercent =
    duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onSeek(ratio * duration);
    },
    [duration, onSeek]
  );

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value);
      setVolume(v);
      if (videoRef.current) {
        videoRef.current.volume = v;
        videoRef.current.muted = v === 0;
      }
      setIsMuted(v === 0);
    },
    [videoRef]
  );

  const handleToggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = !isMuted;
    video.muted = next;
    setIsMuted(next);
    if (!next && video.volume === 0) {
      video.volume = 0.5;
      setVolume(0.5);
    }
  }, [isMuted, videoRef]);

  const handleFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const container = video.closest("[data-video-container]");
    const target = container ?? video;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      target.requestFullscreen().catch(() => undefined);
    }
  }, [videoRef]);

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8">
      {/* プログレスバー */}
      <div
        className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/30 mb-3 group"
        onClick={handleProgressClick}
        role="slider"
        aria-label="シークバー"
        aria-valuenow={Math.floor(currentTime)}
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
      >
        <div
          className="h-full rounded-full bg-white transition-all duration-100"
          style={{ width: `${progressPercent}%` }}
        />
        {/* シークハンドル */}
        <div
          className="absolute top-1/2 -translate-y-1/2 size-3 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity shadow"
          style={{ left: `calc(${progressPercent}% - 6px)` }}
        />
      </div>

      {/* コントロール行 */}
      <div className="flex items-center gap-3">
        {/* 再生/一時停止 */}
        <button
          onClick={onPlayPause}
          className="text-white hover:text-white/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 rounded"
          aria-label={isPlaying ? "一時停止" : "再生"}
        >
          {isPlaying ? (
            <Pause className="size-5" />
          ) : (
            <Play className="size-5" />
          )}
        </button>

        {/* 音量コントロール */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleToggleMute}
            className="text-white hover:text-white/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 rounded"
            aria-label={isMuted ? "ミュート解除" : "ミュート"}
          >
            {isMuted ? (
              <VolumeX className="size-5" />
            ) : (
              <Volume2 className="size-5" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            className="w-16 h-1 accent-white cursor-pointer"
            aria-label="音量"
          />
        </div>

        {/* 時刻表示 */}
        <span className="text-white text-xs tabular-nums ml-1 select-none">
          {formatTime(currentTime)}
          <span className="text-white/50 mx-0.5">/</span>
          {formatTime(duration)}
        </span>

        {/* フルスクリーン（右端） */}
        <button
          onClick={handleFullscreen}
          className="ml-auto text-white hover:text-white/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 rounded"
          aria-label="フルスクリーン"
        >
          <Maximize className="size-5" />
        </button>
      </div>
    </div>
  );
}
