"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

export default function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { user, loading, signInWithGoogle, signOut } = useAuth();

  const navItems = [
    { href: "/super/master/courses", label: "マスターコース" },
    { href: "/super/distribute", label: "テナント配信" },
    { href: "/super/attendance", label: "出席レポート" },
    { href: "/super/settings", label: "設定" },
  ];

  // Firebase認証の読み込み中
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  // 未ログイン → サインイン画面
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">スーパー管理</h1>
          <p className="text-muted-foreground">
            管理者アカウントでサインインしてください
          </p>
          <Button onClick={signInWithGoogle}>
            Googleでサインイン
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="border-b">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold">スーパー管理</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              {user.email}
            </span>
            <Link
              href="/help/super"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ヘルプ
            </Link>
            <Button variant="ghost" size="sm" onClick={signOut}>
              ログアウト
            </Button>
            <Link
              href="/"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              トップへ戻る
            </Link>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
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
                    : "text-muted-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </div>
  );
}
