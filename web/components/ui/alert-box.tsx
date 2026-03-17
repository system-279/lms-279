import { cn } from "@/lib/utils";
import { ReactNode } from "react";

type AlertBoxVariant = "warning" | "info" | "success" | "error";

interface AlertBoxProps {
  variant?: AlertBoxVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}

// shadcn/ui互換: bg-{color}-50 + border-{color}-200 + text-{color}-800
const variantStyles: Record<AlertBoxVariant, string> = {
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-green-200 bg-green-50 text-green-800",
  error: "border-red-200 bg-red-50 text-red-800",
};

const variantTitleStyles: Record<AlertBoxVariant, string> = {
  warning: "text-amber-900",
  info: "text-blue-900",
  success: "text-green-900",
  error: "text-red-900",
};

const variantTextStyles: Record<AlertBoxVariant, string> = {
  warning: "text-amber-800",
  info: "text-blue-800",
  success: "text-green-800",
  error: "text-red-800",
};

export function AlertBox({
  variant = "info",
  title,
  children,
  className,
}: AlertBoxProps) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        variantStyles[variant],
        className
      )}
    >
      {title && (
        <h3
          className={cn(
            "mb-2 text-sm font-semibold",
            variantTitleStyles[variant]
          )}
        >
          {title}
        </h3>
      )}
      <div className={cn("text-sm", variantTextStyles[variant])}>{children}</div>
    </div>
  );
}
