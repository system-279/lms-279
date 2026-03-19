"use client";

import { Button } from "@/components/ui/button";
import type { HelpRole } from "../_data/help-sections";
import { roleLabels } from "../_data/help-sections";

type FilterValue = "all" | HelpRole;

const filters: { value: FilterValue; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "student", label: roleLabels.student },
  { value: "admin", label: roleLabels.admin },
  { value: "super", label: roleLabels.super },
];

export function RoleFilter({
  value,
  onChange,
}: {
  value: FilterValue;
  onChange: (v: FilterValue) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {filters.map((f) => (
        <Button
          key={f.value}
          size="sm"
          variant={value === f.value ? "default" : "outline"}
          onClick={() => onChange(f.value)}
        >
          {f.label}
        </Button>
      ))}
    </div>
  );
}
