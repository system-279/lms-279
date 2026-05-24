"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "success" | "error";

interface InlineFeedbackProps {
  tone: Tone;
  children: React.ReactNode;
  onDismiss?: () => void;
  /** ms。指定なしの場合 success=5000 / error=未自動消去 */
  autoDismissMs?: number;
}

const toneClasses: Record<Tone, string> = {
  success:
    "border-l-emerald-500 bg-emerald-50 text-emerald-900 dark:border-l-emerald-400 dark:bg-emerald-950/60 dark:text-emerald-100",
  error:
    "border-l-rose-500 bg-rose-50 text-rose-900 dark:border-l-rose-400 dark:bg-rose-950/60 dark:text-rose-100",
};

const toneIcon: Record<Tone, React.ReactNode> = {
  success: <CheckCircle2 className="size-4 shrink-0 mt-0.5" aria-hidden />,
  error: <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden />,
};

export function InlineFeedback({
  tone,
  children,
  onDismiss,
  autoDismissMs,
}: InlineFeedbackProps) {
  const effectiveAutoDismissMs = autoDismissMs ?? (tone === "success" ? 5000 : undefined);

  // 親が onDismiss を inline arrow で渡しても auto-dismiss タイマーが
  // 親 re-render の度に reset されないよう、最新の onDismiss は ref で参照する。
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const hasDismiss = onDismiss !== undefined;

  useEffect(() => {
    if (!effectiveAutoDismissMs || !hasDismiss) return;
    const t = window.setTimeout(() => onDismissRef.current?.(), effectiveAutoDismissMs);
    return () => window.clearTimeout(t);
  }, [effectiveAutoDismissMs, hasDismiss]);

  return (
    <div
      role="status"
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={cn(
        "flex max-w-md items-start gap-2.5 rounded-md border border-l-4 px-3 py-2.5 text-sm shadow-sm",
        "animate-in fade-in slide-in-from-top-1 duration-200",
        toneClasses[tone],
      )}
    >
      {toneIcon[tone]}
      <div className="flex-1 leading-snug">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="閉じる"
          className="-m-0.5 rounded p-0.5 opacity-60 transition hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
