"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useHelpRole, type HelpLevel } from "../_hooks/use-help-role";

const LEVEL_RANK: Record<HelpLevel, number> = {
  student: 1,
  admin: 2,
  super: 3,
};

/**
 * ヘルプアクセスレベルに応じてページアクセスを制御するガード
 * 権限不足の場合は /help にリダイレクト
 */
export function HelpAccessGuard({
  requiredLevel,
  children,
}: {
  requiredLevel: HelpLevel;
  children: React.ReactNode;
}) {
  const { helpLevel, loading } = useHelpRole();
  const router = useRouter();

  const hasAccess = LEVEL_RANK[helpLevel] >= LEVEL_RANK[requiredLevel];

  useEffect(() => {
    if (!loading && !hasAccess) {
      router.replace("/help");
    }
  }, [loading, hasAccess, router]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="size-8 rounded-full border-4 border-muted border-t-primary animate-spin" />
      </div>
    );
  }

  if (!hasAccess) {
    return null;
  }

  return <>{children}</>;
}
