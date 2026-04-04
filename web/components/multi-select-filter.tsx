"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

export interface FilterOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  label: string;
  options: FilterOption[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  searchable?: boolean;
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  searchable = false,
}: MultiSelectFilterProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = searchable && search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  const count = selected.size;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-8 text-xs min-w-[120px] justify-between ${count > 0 ? "border-primary text-primary" : ""}`}
        >
          <span className="truncate">
            {count === 0
              ? label
              : count === 1
                ? options.find((o) => selected.has(o.value))?.label ?? label
                : `${label} (${count})`}
          </span>
          <span className="ml-1 text-muted-foreground">▾</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        {searchable && (
          <Input
            placeholder="検索..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs mb-2"
          />
        )}
        <div className="max-h-52 overflow-y-auto space-y-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">該当なし</p>
          ) : (
            filtered.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm"
              >
                <Checkbox
                  checked={selected.has(option.value)}
                  onCheckedChange={() => toggle(option.value)}
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))
          )}
        </div>
        {count > 0 && (
          <div className="border-t mt-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-7 text-xs"
              onClick={clearAll}
            >
              選択をクリア
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
