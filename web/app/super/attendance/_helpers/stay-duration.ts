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

/** 自動補完 session の滞在時間カラム表示文字列。Firestore 一次データは維持し表示層のみで分離する。 */
export const SYNTHETIC_STAY_DURATION_LABEL = "— (テストのみ)";

/**
 * record 単位の滞在時間表示。
 * `isSynthetic=true` は quiz 開始〜提出の所要時間 (= 1〜2 分) が記録されているが、実滞在時間ではないため
 * `SYNTHETIC_STAY_DURATION_LABEL` で表示し、通常 session と数値カラムを混在させない。
 * Phase 3 follow-up #3 (#533): entryAt 書き換え案 (B) は Codex No-Go 判定により表示層分離 (A) を採用。
 *
 * 例外: `entryAt/exitAt` が実際に編集されている場合 (`original` snapshot との差分検知、PR #557) は
 * 管理者が確認した実時刻のため通常計算で表示する。`editedAt` 単独では quizScore/quizPassed のみの
 * 編集でも付与されるため判定材料に使えない (HIGH 指摘反映)。
 * provenance としての `isSynthetic` バッジは UI 側で表示維持されるが、滞在時間は編集後の値を反映する。
 */
export function formatRecordStayDuration(record: {
  isSynthetic: boolean;
  entryAt: string | null;
  exitAt: string | null;
  original?: {
    entryAt: string | null;
    exitAt: string | null;
  };
}): string {
  if (record.isSynthetic && !isStayTimeEdited(record)) return SYNTHETIC_STAY_DURATION_LABEL;
  return formatStayDuration(calculateStayDurationMs(record.entryAt, record.exitAt));
}

/**
 * `entryAt/exitAt` が初回値 (`original` snapshot) から実際に変更されたか判定。
 * `original` が undefined (PR #557 投入前データ) や entryAt/exitAt が初回値と一致の場合は false。
 * ソート判定にも使うため export。
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
