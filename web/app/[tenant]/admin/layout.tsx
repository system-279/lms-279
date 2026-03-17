"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTenant } from "@/lib/tenant-context";
import { cn } from "@/lib/utils";

/**
 * テナント対応管理者レイアウト
 * LMS管理メニューのサブナビゲーションを提供
 */
export default function TenantAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { tenantId } = useTenant();
  const pathname = usePathname();

  const navItems = [
    { href: `/${tenantId}/admin/courses`, label: "講座管理" },
    { href: `/${tenantId}/admin/lessons`, label: "レッスン管理" },
    { href: `/${tenantId}/admin/users`, label: "受講者管理" },
    { href: `/${tenantId}/admin/allowed-emails`, label: "許可メール管理" },
    { href: `/${tenantId}/admin/analytics`, label: "分析" },
  ];

  return (
    <div className="space-y-4">
      {/* サブナビゲーション */}
      <nav className="flex gap-4 text-sm border-b pb-2 overflow-x-auto">
        {navItems.map((item) => {
          const isActive = pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "whitespace-nowrap hover:text-foreground transition-colors",
                isActive
                  ? "text-foreground font-medium border-b-2 border-foreground pb-2 -mb-2"
                  : "text-muted-foreground"
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
