/**
 * 編集履歴 (Issue #556) の判定・表示ヘルパー。
 *
 * 初回 PATCH 時に `lesson_sessions.original` フィールドへ immutable snapshot を保存し、
 * `editedAt` で編集時刻を記録する。本ヘルパーは UI 側で「編集済」バッジを出すか判定し、
 * tooltip に表示する元データ文字列を組み立てる。
 */

import type { SuperAttendanceRecord } from "@lms-279/shared-types";

type OriginalSnapshot = NonNullable<SuperAttendanceRecord["original"]>;

/** record に `original` snapshot が存在するか (= 編集済か) を判定する。型述語版で呼び出し側の non-null assertion を不要化。 */
export function hasOriginalSnapshot<T extends Pick<SuperAttendanceRecord, "original">>(
  record: T,
): record is T & { original: OriginalSnapshot } {
  return record.original !== undefined && record.original !== null;
}

/** ISO8601 文字列を JST `HH:mm` 表記に変換 (null → `—`)。バッジ tooltip 用の簡易フォーマット。 */
function formatTimeJST(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

/**
 * 元データ snapshot を tooltip 用に整形した複数行文字列を返す。
 * 例:
 *   編集前:
 *   入室 14:30 / 退室 16:45
 *   点数 100点 / 合格
 */
export function formatOriginalTooltip(original: OriginalSnapshot): string {
  const entry = formatTimeJST(original.entryAt);
  const exit = formatTimeJST(original.exitAt);
  const score = original.quizScore !== null ? `${original.quizScore}点` : "—";
  const passed = original.quizPassed === null ? "未受験" : original.quizPassed ? "合格" : "不合格";
  return `編集前:\n入室 ${entry} / 退室 ${exit}\n点数 ${score} / ${passed}`;
}
