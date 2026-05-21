"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { stripInvisibleChars } from "@/lib/sanitize-path";
import { extractErrorName } from "@/lib/error-utils";

type CopyState = "idle" | "copied" | "failed";

interface CopyButtonProps {
  text: string;
}

/**
 * Issue #456: writeText に渡すテキストの不可視文字 (U+FE0E 等) を除去。
 * Issue #458: writeText 失敗時にユーザーへ視覚フィードバックを出す。
 *   - 「コピー失敗」ボタン表示 + 「URL を選択して手動コピーしてください」alert
 *   - 失敗 4 秒後に idle 復帰 (成功時は 2 秒)
 * PR #459 review: timer race / unmount cleanup / a11y / 構造化ログ対応。
 */
export function CopyButton({ text }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const schedule = (next: CopyState, ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setState(next);
    timerRef.current = setTimeout(() => setState("idle"), ms);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(stripInvisibleChars(text));
      schedule("copied", 2000);
    } catch (err) {
      console.error("[CopyButton] clipboard.writeText failed", {
        errorName: extractErrorName(err),
        isSecureContext:
          typeof window !== "undefined" ? window.isSecureContext : null,
      });
      schedule("failed", 4000);
    }
  };

  const visibleLabel =
    state === "copied"
      ? "コピーしました"
      : state === "failed"
        ? "コピー失敗"
        : "コピー";

  const ariaLabel = state === "idle" ? "リンクをコピー" : visibleLabel;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="shrink-0"
        aria-label={ariaLabel}
      >
        {visibleLabel}
      </Button>
      {state === "failed" && (
        <p className="text-xs text-red-600" role="alert">
          URL を選択して手動コピーしてください
        </p>
      )}
    </div>
  );
}
