"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { HelpSection } from "../_data/help-sections";
import { HelpSearch } from "./HelpSearch";
import { TableOfContents } from "./TableOfContents";
import { FeatureSection } from "./FeatureSection";

export function RoleHelpPage({
  roleName,
  sections,
}: {
  roleName: string;
  sections: HelpSection[];
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return sections;

    const q = search.trim().toLowerCase();
    return sections.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.keywords.some((k) => k.toLowerCase().includes(q)) ||
        s.steps.some(
          (st) =>
            st.title.toLowerCase().includes(q) ||
            st.detail?.toLowerCase().includes(q)
        )
    );
  }, [sections, search]);

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Link
              href="/help"
              className="text-sm text-muted-foreground hover:text-foreground transition"
            >
              ヘルプセンター
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="font-semibold">{roleName}</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/super/master/courses"
              className="text-sm text-muted-foreground hover:text-foreground transition"
            >
              スーパー管理
            </Link>
            <Link
              href="/"
              className="text-sm text-muted-foreground hover:text-foreground transition"
            >
              LMS に戻る
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="border-b bg-card py-10">
        <div className="mx-auto max-w-7xl px-4">
          <h1 className="text-3xl font-bold">{roleName}向けヘルプ</h1>
          <p className="mt-2 text-muted-foreground">
            {roleName}向けの各機能の使い方を解説しています。
          </p>
          <div className="mt-6">
            <HelpSearch value={search} onChange={setSearch} />
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="mx-auto flex max-w-7xl gap-8 px-4 py-8">
        {/* Sidebar TOC - desktop only */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-24">
            <TableOfContents sections={filtered} />
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1 space-y-6">
          {/* Mobile TOC */}
          <details className="rounded-lg border p-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium">
              目次を表示
            </summary>
            <div className="mt-2">
              <TableOfContents sections={filtered} />
            </div>
          </details>

          {filtered.length === 0 && (
            <p className="py-12 text-center text-muted-foreground">
              該当するセクションが見つかりません。
            </p>
          )}

          {filtered.map((section) => (
            <FeatureSection key={section.id} section={section} />
          ))}
        </main>
      </div>

      {/* Footer */}
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>LMS 279 &copy; {new Date().getFullYear()}</p>
      </footer>
    </>
  );
}
