"use client";

import { useEffect, useState } from "react";
import type { HelpSection } from "../_data/help-sections";

export function TableOfContents({
  sections,
}: {
  sections: HelpSection[];
}) {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 }
    );

    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sections]);

  const handleClick = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <nav className="space-y-1">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        目次
      </p>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => handleClick(section.id)}
          className={`block w-full text-left rounded px-2 py-1.5 text-sm transition ${
            activeId === section.id
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          {section.title}
        </button>
      ))}
    </nav>
  );
}
