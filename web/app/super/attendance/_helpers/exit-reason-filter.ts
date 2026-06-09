/**
 * 退室理由フィルタ用 sentinel と判定関数。
 *
 * SuperAttendanceRecord.exitReason は string | null だが、FilterOption.value は string のみ。
 * exitReason=null (在室中/異常終了で退室理由未確定) のセッションを表すために sentinel "__none__" を使う。
 */

export const EXIT_REASON_NONE_VALUE = "__none__";
export const EXIT_REASON_NONE_LABEL = "未退出";

/**
 * フィルタ選択状態 (Set<string>) に対し、レコードの exitReason がマッチするか判定。
 * null の場合は EXIT_REASON_NONE_VALUE が選択されていればマッチ。
 */
export function matchesExitReasonFilter(
  recordExitReason: string | null,
  selectedReasons: Set<string>,
): boolean {
  if (recordExitReason === null) {
    return selectedReasons.has(EXIT_REASON_NONE_VALUE);
  }
  return selectedReasons.has(recordExitReason);
}
