"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTenant } from "@/lib/tenant-context";
import { useAuth } from "@/lib/auth-context";
import { useAuthFetch } from "@/lib/auth-fetch-context";
import { cn } from "@/lib/utils";

/**
 * テナント対応管理者レイアウト
 * adminロール以外はテナントトップにリダイレクト
 */
export default function TenantAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { tenantId, isDemo } = useTenant();
  const { user, loading: authLoading } = useAuth();
  const authFetch = useAuthFetch();
  const router = useRouter();
  const pathname = usePathname();
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) return;

    // デモモードはガードなし
    if (isDemo) {
      setAuthorized(true);
      return;
    }

    if (!user) {
      setAuthorized(false);
      return;
    }

    const checkAccess = async () => {
      try {
        const data = await authFetch<{ user?: { role?: string }; isSuperAdminAccess?: boolean }>("/auth/me");
        const role = data.user?.role;
        // admin のみ許可（スーパー管理者は tenant-auth で role="admin" に上書き済み）
        setAuthorized(role === "admin");
      } catch {
        setAuthorized(false);
      }
    };

    checkAccess();
  }, [authFetch, user, authLoading, isDemo]);

  useEffect(() => {
    if (authorized === false) {
      router.replace(`/${tenantId}`);
    }
  }, [authorized, router, tenantId]);

  // ローディング中
  if (authorized === null) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="size-8 rounded-full border-4 border-muted border-t-primary animate-spin" />
      </div>
    );
  }

  // 権限なし（リダイレクト中）
  if (!authorized) {
    return null;
  }

  const navItems = [
    { href: `/${tenantId}/admin`, label: "ダッシュボード", exact: true },
    { href: `/${tenantId}/admin/courses`, label: "講座管理" },
    { href: `/${tenantId}/admin/users`, label: "受講者管理" },
    { href: `/${tenantId}/admin/allowed-emails`, label: "許可メール管理" },
    { href: `/${tenantId}/admin/analytics`, label: "分析" },
  ];

  return (
    <div className="space-y-4">
      {/* サブナビゲーション */}
      <nav className="flex gap-4 text-sm border-b pb-2 overflow-x-auto">
        {navItems.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname?.startsWith(item.href);
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
