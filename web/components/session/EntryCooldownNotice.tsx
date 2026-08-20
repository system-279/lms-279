"use client";

import { useEffect, useRef, useState } from "react";

interface EntryCooldownState {
  remainingSec: number;
  active: boolean;
}

/**
 * F1（入室最小間隔、ADR-027 ケースG）: 残り待機秒数を 1 秒ごとに tick するフック。
 *
 * `retryAfterMs`（サーバーからの初回値）を起点に、以降はクライアント時計で
 * ローカルにカウントダウンする（SessionTimer の deadlineAt 方式と同様、ドリフト防止のため
 * 毎tickでの再フェッチはしない）。0 秒到達後は `active=false` になるが、
 * 再生ボタンの押下は常に手動操作が必要（自動再生はしない）。
 */
export function useEntryCooldown(retryAfterMs: number | undefined): EntryCooldownState {
  const [remainingMs, setRemainingMs] = useState<number>(() => Math.max(0, retryAfterMs ?? 0));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (retryAfterMs === undefined || retryAfterMs <= 0) {
      setRemainingMs(0);
      return;
    }

    const deadline = Date.now() + retryAfterMs;
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      setRemainingMs(left);
      if (left === 0 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [retryAfterMs]);

  return {
    remainingSec: Math.ceil(remainingMs / 1000),
    active: remainingMs > 0,
  };
}

function cooldownMessage(remainingSec: number): string {
  return `もう少しお待ちください。出席の記録を正確に残すため、前のレッスンを退室してから次のレッスンに入室するまで少し間隔をあけていただいています。あと${remainingSec}秒で開始できます。学習データは失われていませんので、そのままお待ちください。`;
}

interface EntryCooldownInlineProps {
  remainingSec: number;
}

/** 動画プレイヤー上部に常時表示するインラインバナー（事前ゲート表示、F1 の主経路）。 */
export function EntryCooldownInline({ remainingSec }: EntryCooldownInlineProps) {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {cooldownMessage(remainingSec)}
    </div>
  );
}

export type { EntryCooldownState };
