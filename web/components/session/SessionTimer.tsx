"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface SessionTimerProps {
  deadlineAt: string;
  onExpired: () => void;
}

export function SessionTimer({ deadlineAt, onExpired }: SessionTimerProps) {
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    return Math.max(0, new Date(deadlineAt).getTime() - Date.now());
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiredRef = useRef(false);

  const handleExpired = useCallback(() => {
    if (!expiredRef.current) {
      expiredRef.current = true;
      onExpired();
    }
  }, [onExpired]);

  useEffect(() => {
    expiredRef.current = false;

    const tick = () => {
      const left = Math.max(0, new Date(deadlineAt).getTime() - Date.now());
      setRemainingMs(left);
      if (left === 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        handleExpired();
      }
    };

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [deadlineAt, handleExpired]);

  const totalSec = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  const remainingText = `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  const deadlineDate = new Date(deadlineAt);
  const deadlineText = `${deadlineDate.getHours().toString().padStart(2, "0")}:${deadlineDate.getMinutes().toString().padStart(2, "0")}`;

  const remainingMinutes = totalSec / 60;

  let bgClass: string;
  if (remainingMinutes <= 10) {
    bgClass = "bg-red-100 border-red-300 text-red-900 animate-pulse";
  } else if (remainingMinutes <= 30) {
    bgClass = "bg-amber-100 border-amber-300 text-amber-900";
  } else {
    bgClass = "bg-muted";
  }

  return (
    <div
      className={`sticky top-0 z-40 flex items-center justify-center gap-2 border-b px-4 py-2 text-sm font-medium ${bgClass}`}
    >
      <span>{"⏰"} 制限時間: {deadlineText} まで（残り {remainingText}）</span>
    </div>
  );
}
