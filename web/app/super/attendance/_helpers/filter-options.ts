import type { FilterOption } from "@/components/multi-select-filter";

/**
 * 文字列を自然順（数字接頭辞は 1,2,...,10 の順）で比較する。
 * `localeCompare` に `numeric: true` を渡さないと "10." が "2." より前に来る。
 * レッスン名等の「番号. タイトル」形式の文字列比較で共通利用する。
 */
export function compareStringsNaturally(a: string, b: string): number {
  return a.localeCompare(b, "ja", { numeric: true });
}

/** フィルタ選択肢を自然順でソートする。 */
export function sortFilterOptionsByLabel(options: FilterOption[]): FilterOption[] {
  return [...options].sort((a, b) => compareStringsNaturally(a.label, b.label));
}
