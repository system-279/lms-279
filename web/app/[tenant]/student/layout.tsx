"use client";

import Link from "next/link";
import { useTenant } from "@/lib/tenant-context";

/**
 * テナント対応受講者レイアウト
 */
export default function TenantStudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { tenantId } = useTenant();

  return (
    <div className="space-y-4">
      {/* サブナビゲーション */}
      <nav className="flex gap-4 text-sm border-b pb-2">
        <Link
          href={`/${tenantId}/student/courses`}
          className="text-muted-foreground hover:text-foreground"
        >
          講座一覧
        </Link>
      </nav>
      {children}
    </div>
  );
}
