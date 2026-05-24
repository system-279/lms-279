"use client";

/**
 * 配信スケジュール編集 (曜日 + 時刻)。controlled component。
 * - daysOfWeek: 0-6 (日-土) の配列。空配列なら常に skip
 * - hourJst: 0-23 (JST、HH:00 単位)
 */

import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface ScheduleValue {
  daysOfWeek: number[];
  hourJst: number;
}

interface ScheduleEditorProps {
  daysOfWeek: number[];
  hourJst: number;
  onChange: (next: ScheduleValue) => void;
  disabled?: boolean;
}

export function ScheduleEditor({
  daysOfWeek,
  hourJst,
  onChange,
  disabled = false,
}: ScheduleEditorProps) {
  const toggleDay = (day: number) => {
    const set = new Set(daysOfWeek);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    onChange({
      daysOfWeek: [...set].sort((a, b) => a - b),
      hourJst,
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="text-sm font-medium">配信曜日</span>
        <div className="flex flex-wrap gap-3">
          {DAY_LABELS.map((label, day) => (
            <label
              key={day}
              className="flex items-center gap-1.5 text-sm cursor-pointer"
            >
              <Checkbox
                checked={daysOfWeek.includes(day)}
                onCheckedChange={() => toggleDay(day)}
                disabled={disabled}
                aria-label={`${label}曜日`}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {daysOfWeek.length === 0 && (
          <p className="text-xs text-muted-foreground">
            曜日を 1 つ以上選んでください。未選択のままだと配信されません。
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">配信時刻 (JST)</span>
        <Select
          value={String(hourJst)}
          onValueChange={(v) =>
            onChange({ daysOfWeek, hourJst: Number(v) })
          }
          disabled={disabled}
        >
          <SelectTrigger className="w-32" aria-label="配信時刻">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 24 }, (_, h) => (
              <SelectItem key={h} value={String(h)}>
                {String(h).padStart(2, "0")}:00
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          選択した曜日の指定時刻台に自動配信されます（例: 09:00 を選ぶと 09:00〜09:59 の間）。
        </p>
      </div>
    </div>
  );
}
