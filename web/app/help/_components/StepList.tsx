"use client";

import type { HelpStep } from "../_data/help-sections";

export function StepList({ steps }: { steps: HelpStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
            {i + 1}
          </span>
          <div className="pt-0.5">
            <p className="font-medium">{step.title}</p>
            {step.detail && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                {step.detail}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
