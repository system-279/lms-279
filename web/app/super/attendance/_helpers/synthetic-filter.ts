/**
 * Session 種別フィルタ（合成 session = isSynthetic=true）の判定関数と定数。
 *
 * Issue #533 Phase 3 / #551:
 *   Phase 1 (PR #537) で合成 session 自動作成、Phase 2 (PR #539/#541) で過去 17 件遡及補正後、
 *   出席レポートで合成 session を視覚識別するための運用補助フィルタ。
 */

export type SyntheticKind = "all" | "synthetic_only" | "actual_only";

export const SYNTHETIC_KIND_OPTIONS: { value: SyntheticKind; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "synthetic_only", label: "自動補完のみ" },
  { value: "actual_only", label: "実 session のみ" },
];

/** 純粋関数: SyntheticKind フィルタ値とレコードの isSynthetic を突き合わせて表示すべきか判定。 */
export function matchesIsSyntheticFilter(
  recordIsSynthetic: boolean,
  kind: SyntheticKind,
): boolean {
  switch (kind) {
    case "all":
      return true;
    case "synthetic_only":
      return recordIsSynthetic === true;
    case "actual_only":
      return recordIsSynthetic === false;
    default: {
      // SyntheticKind に新しい値が追加された際、TypeScript が網羅漏れを検出する
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
