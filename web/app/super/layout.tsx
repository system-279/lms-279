"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export default function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const navItems = [
    { href: "/super/master/courses", label: "マスターコース" },
    { href: "/super/distribute", label: "テナント配信" },
    { href: "/super/settings", label: "設定" },
  ];

  return (
    <div className="min-h-screen">
      <div className="border-b">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold">スーパー管理</h1>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            トップへ戻る
          </Link>
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
