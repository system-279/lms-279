"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface PauseTimeoutOverlayProps {
  isPaused: boolean;
  timeoutSeconds?: number;
  onTimeout: () => void;
}

export function PauseTimeoutOverlay({
  isPaused,
  timeoutSeconds = 900,
  onTimeout,
}: PauseTimeoutOverlayProps) {
  const [remainingSec, setRemainingSec] = useState(timeoutSeconds);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutFired = useRef(false);

  const handleTimeout = useCallback(() => {
    if (!timeoutFired.current) {
      timeoutFired.current = true;
      onTimeout();
    }
  }, [onTimeout]);

  useEffect(() => {
    if (!isPaused) {
      // Reset on unpause
      setRemainingSec(timeoutSeconds);
      timeoutFired.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Start countdown when paused
    const tick = () => {
      setRemainingSec((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          handleTimeout();
          return 0;
        }
        return next;
      });
    };

    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isPaused, timeoutSeconds, handleTimeout]);

  if (!isPaused) return null;

  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  const displayTime = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 pointer-events-none">
      <div className="rounded-lg bg-background/95 px-6 py-4 text-center shadow-lg">
        <p className="text-sm font-medium">
          一時停止中 — 残り {displayTime} で自動退室
        </p>
      </div>
    </div>
  );
}
