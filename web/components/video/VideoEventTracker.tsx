"use client";

import { useEffect, useRef, useCallback } from "react";

interface VideoEvent {
  eventType:
    | "play"
    | "pause"
    | "seeking"
    | "seeked"
    | "ended"
    | "ratechange"
    | "heartbeat";
  position: number;
  seekFrom?: number;
  playbackRate: number;
  clientTimestamp: number;
}

interface VideoEventTrackerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoId: string;
  sessionToken: string;
  apiEndpoint: string;
  fetchFn: (url: string, options?: RequestInit) => Promise<Response>;
}

const BATCH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 50;
const HEARTBEAT_INTERVAL_S = 5;

export function VideoEventTracker({
  videoRef,
  videoId,
  sessionToken,
  apiEndpoint,
  fetchFn,
}: VideoEventTrackerProps) {
  const eventQueueRef = useRef<VideoEvent[]>([]);
  const lastHeartbeatTimeRef = useRef<number>(-1);
  const seekFromRef = useRef<number | null>(null);
  const batchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flushEvents = useCallback(
    async (events: VideoEvent[]) => {
      if (events.length === 0) return;
      try {
        await fetchFn(apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId, sessionToken, events }),
        });
      } catch {
        // サーバーサイドで不審パターン検出するため、送信失敗は記録のみ
        // ADR-022: 不審パターン検出はサーバーサイド
      }
    },
    [apiEndpoint, fetchFn, videoId, sessionToken]
  );

  const drainQueue = useCallback(async () => {
    if (eventQueueRef.current.length === 0) return;
    const batch = eventQueueRef.current.splice(0, MAX_BATCH_SIZE);
    await flushEvents(batch);
  }, [flushEvents]);

  const enqueueEvent = useCallback((event: VideoEvent) => {
    eventQueueRef.current.push(event);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      enqueueEvent({
        eventType: "play",
        position: video.currentTime,
        playbackRate: video.playbackRate,
        clientTimestamp: Date.now(),
      });
    };

    const handlePause = () => {
      enqueueEvent({
        eventType: "pause",
        position: video.currentTime,
        playbackRate: video.playbackRate,
        clientTimestamp: Date.now(),
      });
    };

    const handleSeeking = () => {
      seekFromRef.current = video.currentTime;
      enqueueEvent({
        eventType: "seeking",
        position: video.currentTime,
        playbackRate: video.playbackRate,
        clientTimestamp: Date.now(),
      });
    };

    const handleSeeked = () => {
      enqueueEvent({
        eventType: "seeked",
        position: video.currentTime,
        seekFrom: seekFromRef.current ?? undefined,
        playbackRate: video.playbackRate,
        clientTimestamp: Date.now(),
      });
      seekFromRef.current = null;
    };

    const handleEnded = () => {
      enqueueEvent({
        eventType: "ended",
        position: video.currentTime,
        playbackRate: video.playbackRate,
        clientTimestamp: Date.now(),
      });
    };

    const handleRateChange = () => {
      enqueueEvent({
        eventType: "ratechange",
        position: video.currentTime,
        playbackRate: video.playbackRate,
        clientTimestamp: Date.now(),
      });
    };

    // heartbeat: timeupdateイベントで5秒ごとに生成（ADR-021）
    const handleTimeUpdate = () => {
      const currentSecond = Math.floor(video.currentTime);
      if (
        currentSecond > 0 &&
        currentSecond !== lastHeartbeatTimeRef.current &&
        currentSecond % HEARTBEAT_INTERVAL_S === 0
      ) {
        lastHeartbeatTimeRef.current = currentSecond;
        enqueueEvent({
          eventType: "heartbeat",
          position: video.currentTime,
          playbackRate: video.playbackRate,
          clientTimestamp: Date.now(),
        });
      }
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeking", handleSeeking);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("ratechange", handleRateChange);
    video.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("ratechange", handleRateChange);
      video.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [videoRef, enqueueEvent]);

  // 5秒間隔バッチ送信（ADR-021）
  useEffect(() => {
    batchIntervalRef.current = setInterval(() => {
      drainQueue();
    }, BATCH_INTERVAL_MS);

    return () => {
      if (batchIntervalRef.current !== null) {
        clearInterval(batchIntervalRef.current);
        batchIntervalRef.current = null;
      }
    };
  }, [drainQueue]);

  // ページ離脱時にnavigator.sendBeaconで未送信イベントを送信
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (eventQueueRef.current.length === 0) return;
      const batch = eventQueueRef.current.splice(0, MAX_BATCH_SIZE);
      const payload = JSON.stringify({ videoId, sessionToken, events: batch });
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(
          apiEndpoint,
          new Blob([payload], { type: "application/json" })
        );
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [apiEndpoint, videoId, sessionToken]);

  // このコンポーネントはUIを持たない
  return null;
}
