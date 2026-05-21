"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { stripInvisibleChars } from "@/lib/sanitize-path";
import { extractErrorName } from "@/lib/error-utils";

type CopyState = "idle" | "copied" | "failed";

interface CopyButtonProps {
  text: string;
  /** idle 時のボタン表示文言。default "コピー"。copied/failed 状態の文言は固定。 */
  label?: string;
  /**
   * idle 時の aria-label (支援技術向け文脈付与)。
   * default: label === "コピー" のとき "リンクをコピー" (PR #459 で導入した a11y 補強)、
   *          それ以外は label と同じ。
   * copied/failed 時は visible label と一致 (state 連動)。
   */
  ariaLabel?: string;
}

/**
 * Issue #456: writeText に渡すテキストの不可視文字 (U+FE0E 等) を除去。
 * Issue #458: writeText 失敗時にユーザーへ視覚フィードバックを出す。
 *   - 「コピー失敗」ボタン表示 + 「URL を選択して手動コピーしてください」alert
 *   - 失敗 4 秒後に idle 復帰 (成功時は 2 秒)
 * PR #459 review: timer race / unmount cleanup / a11y / 構造化ログ対応。
 * Issue #460: register/page.tsx の重複ローカル CopyButton を本 component に統合。
 *   label prop で idle 時の表示を customizable に + ariaLabel prop で a11y 文脈を独立制御。
 */
export function CopyButton({
  text,
  label = "コピー",
  ariaLabel: ariaLabelProp,
}: CopyButtonProps) {
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
        : label;

  // aria-label: idle 時は ariaLabelProp > 「リンクをコピー」(label が default のとき) > label。
  // copied/failed 時は visible label と一致 (state 変化を支援技術に伝える)。
  const idleAriaLabel =
    ariaLabelProp ?? (label === "コピー" ? "リンクをコピー" : label);
  const ariaLabel = state === "idle" ? idleAriaLabel : visibleLabel;

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
