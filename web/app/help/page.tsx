"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHelpRole, type HelpLevel } from "./_hooks/use-help-role";

const roles = [
  {
    href: "/help/student",
    title: "受講者向けヘルプ",
    description: "講座の受講方法、動画視聴、テスト受験について",
    requiredLevel: "student" as HelpLevel,
    items: ["動画の視聴方法と出席ルール", "テストの受け方・合格基準", "進捗の確認方法"],
  },
  {
    href: "/help/admin",
    title: "管理者向けヘルプ",
    description: "講座管理、動画・テスト設定、分析について",
    requiredLevel: "admin" as HelpLevel,
    items: [
      "講座の作成・公開・管理",
      "動画登録とテスト作成（Google連携対応）",
      "受講者の進捗分析・出席管理",
    ],
  },
  {
    href: "/help/super",
    title: "スーパー管理者向けヘルプ",
    description: "マスター講座管理、テナント配信、管理者設定について",
    requiredLevel: "super" as HelpLevel,
    items: [
      "マスター講座の作成・プレビュー",
      "テナントへの講座配信・再配信",
      "スーパー管理者の追加・削除",
    ],
  },
];

const LEVEL_RANK: Record<HelpLevel, number> = {
  student: 1,
  admin: 2,
  super: 3,
};

export default function HelpPage() {
  const { helpLevel, loading } = useHelpRole();

  const visibleRoles = roles.filter(
    (role) => LEVEL_RANK[helpLevel] >= LEVEL_RANK[role.requiredLevel]
  );

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <span className="font-semibold">介護DX college２７９Classroom ヘルプセンター</span>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground transition"
          >
            LMS に戻る
          </Link>
        </div>
      </header>

      {/* Hero */}
      <div className="border-b bg-card py-10">
        <div className="mx-auto max-w-7xl px-4">
          <h1 className="text-3xl font-bold">介護DX college２７９Classroom ヘルプセンター</h1>
          <p className="mt-2 text-muted-foreground">
            ご利用の役割に応じたヘルプをお選びください。
          </p>
        </div>
      </div>

      {/* Cards */}
      <div className="mx-auto max-w-7xl px-4 py-12">
        {loading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-48 rounded-lg border bg-muted/30 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visibleRoles.map((role) => (
              <Link key={role.href} href={role.href} className="group">
                <Card className="h-full transition hover:border-primary/40 hover:shadow-md">
                  <CardHeader>
                    <CardTitle className="text-lg group-hover:text-primary transition">
                      {role.title}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {role.description}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1.5 text-sm text-muted-foreground">
                      {role.items.map((item) => (
                        <li key={item} className="flex items-start gap-2">
                          <span className="mt-1 text-primary">&#8226;</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>介護DX college２７９Classroom &copy; {new Date().getFullYear()}</p>
      </footer>
    </>
  );
}
