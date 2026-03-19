"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

export function HelpSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const handleChange = (v: string) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), 300);
  };

  return (
    <Input
      type="search"
      placeholder="キーワードで検索..."
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      className="max-w-sm"
    />
  );
}
