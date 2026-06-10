/**
 * セッション滞在時間 (入室→退室の経過時間) 計算・整形ヘルパー。
 *
 * 出席レポート (`/super/attendance`) で表示。
 * 計算は FE 側で完結 (API/shared-types 変更なし)、ソート時は ms 値で比較する。
 */

/**
 * 入室・退室時刻 (ISO 文字列) から滞在時間 ms を計算。
 * 入室 or 退室いずれかが null、または exitAt < entryAt の異常データは null を返す。
 */
export function calculateStayDurationMs(
  entryAt: string | null,
  exitAt: string | null,
): number | null {
  if (!entryAt || !exitAt) return null;
  const entryMs = new Date(entryAt).getTime();
  const exitMs = new Date(exitAt).getTime();
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs)) return null;
  const diff = exitMs - entryMs;
  if (diff < 0) return null;
  return diff;
}

/**
 * 滞在時間 ms を「H時間M分」形式に整形。
 * - null → "—"
 * - 0 分以上 1 時間未満 → "M分"
 * - 1 時間以上 → "H時間M分" (0 分のときも "H時間0分" で時間部分を残す)
 */
export function formatStayDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

/**
 * `entryAt/exitAt` が初回値 (`original` snapshot) から実際に変更されたか判定。
 * `original` が undefined (PR #557 投入前データ) や entryAt/exitAt が初回値と一致の場合は false。
 *
 * Phase 3 follow-up #4 (#533): PR #559 の表示層分離 (A 案) は D 案 (Firestore データ修復) へ転換のため撤回。
 * 本 helper は将来の差分検知用途 (no-op 更新で編集済化を防ぐ独立改善等) のため維持。
 */
export function isStayTimeEdited(record: {
  entryAt: string | null;
  exitAt: string | null;
  original?: { entryAt: string | null; exitAt: string | null };
}): boolean {
  if (!record.original) return false;
  return (
    record.entryAt !== record.original.entryAt ||
    record.exitAt !== record.original.exitAt
  );
}
