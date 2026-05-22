/**
 * Phase 5 super-admin 一覧 API 用の cursor ページネーション (in-memory)。
 *
 * storage が全件返す前提で、route 層で安定ソート済みの配列を limit ごとに切り出す。
 * cursor は各要素の一意キー (auditId / runId 等) を使い、次ページはそのキーの直後から。
 * 小規模 + TTL 365 日でデータ量が限定的なため全件取得 + in-memory paginate を採用
 * (Firestore composite index 不要)。
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** query の limit 文字列を 1..MAX に正規化 (不正/未指定は DEFAULT) */
export function resolveLimit(raw: unknown): number {
  const n =
    typeof raw === "string"
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(n, MAX_PAGE_LIMIT);
}

/**
 * 安定ソート済み配列を cursor 起点で limit 件切り出す。
 *
 * @param sortedItems 呼び出し側で安定ソート済 (新しい順など)
 * @param keyOf 各要素の一意キー (cursor に使う)
 * @param cursor 前ページ末尾要素のキー (未指定なら先頭から)
 * @param limit ページサイズ
 */
export function paginateByCursor<T>(
  sortedItems: T[],
  keyOf: (item: T) => string,
  cursor: string | undefined,
  limit: number,
): { page: T[]; nextCursor: string | null } {
  let startIdx = 0;
  if (cursor) {
    const idx = sortedItems.findIndex((it) => keyOf(it) === cursor);
    // cursor が見つからない場合は防御的に先頭から (古いデータ TTL 削除等)
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  const page = sortedItems.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < sortedItems.length;
  const nextCursor =
    hasMore && page.length > 0 ? keyOf(page[page.length - 1]) : null;
  return { page, nextCursor };
}
