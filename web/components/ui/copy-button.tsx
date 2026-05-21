"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { stripInvisibleChars } from "@/lib/sanitize-path";

type CopyState = "idle" | "copied" | "failed";

interface CopyButtonProps {
  text: string;
}

/**
 * Issue #456: writeText に渡すテキストの不可視文字 (U+FE0E 等) を除去。
 * Issue #458: writeText 失敗時にユーザーへ視覚フィードバックを出す。
 *   - 「コピー失敗」ボタン表示 + 「URL を選択して手動コピーしてください」alert
 *   - 失敗 4 秒後に idle 復帰 (成功時は 2 秒)
 */
export function CopyButton({ text }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(stripInvisibleChars(text));
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      console.error("[CopyButton] clipboard.writeText failed", err);
      setState("failed");
      setTimeout(() => setState("idle"), 4000);
    }
  };

  const label =
    state === "copied"
      ? "コピーしました"
      : state === "failed"
        ? "コピー失敗"
        : "コピー";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="shrink-0"
        aria-label="リンクをコピー"
      >
        {label}
      </Button>
      {state === "failed" && (
        <p className="text-xs text-red-600" role="alert">
          URL を選択して手動コピーしてください
        </p>
      )}
    </div>
  );
}
