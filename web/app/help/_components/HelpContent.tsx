"use client";

import { useMemo, useState } from "react";
import type { HelpRole } from "../_data/help-sections";
import { helpSections } from "../_data/help-sections";
import { RoleFilter } from "./RoleFilter";
import { HelpSearch } from "./HelpSearch";
import { TableOfContents } from "./TableOfContents";
import { FeatureSection } from "./FeatureSection";

type FilterValue = "all" | HelpRole;

export function HelpContent() {
  const [roleFilter, setRoleFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let sections = helpSections;

    if (roleFilter !== "all") {
      sections = sections.filter((s) => s.roles.includes(roleFilter));
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      sections = sections.filter(
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
    }

    return sections;
  }, [roleFilter, search]);

  return (
    <>
      {/* Hero */}
      <div className="border-b bg-card py-10">
        <div className="mx-auto max-w-7xl px-4">
          <h1 className="text-3xl font-bold">LMS 279 ヘルプセンター</h1>
          <p className="mt-2 text-muted-foreground">
            各機能の使い方をスクリーンショット付きで解説しています。
          </p>
          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center">
            <HelpSearch value={search} onChange={setSearch} />
            <RoleFilter value={roleFilter} onChange={setRoleFilter} />
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
    </>
  );
}
