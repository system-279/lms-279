/**
 * PDF 出力 (window.print()) 時に非選択カラムを一時非表示にする DOM 操作 helper。
 *
 * Issue #252 (PDF 出力カラム選択) の `handlePrintPdf` から pure 関数を抽出して unit test 可能にしたもの。
 * window.print() / afterprint event / setTimeout fallback / requestAnimationFrame 等の
 * ブラウザ API 依存部分は呼び出し側 (page.tsx) に残し、本 helper は DOM 操作のみを担う。
 */

/**
 * `rootEl` 配下の `[data-col="<key>"]` 要素のうち、`selectedColumnKeys` に含まれないものを
 * `style.display = "none"` で一時非表示にする。
 *
 * @param rootEl 探索の起点となる HTMLElement（典型的には表全体を囲む div）
 * @param allColumnKeys 全カラムキー（既知の data-col 値の列挙、表示順）
 * @param selectedColumnKeys ユーザーが PDF 出力対象として選んだカラムキー集合
 * @returns 非表示にした HTMLElement の配列（{@link restorePdfColumnDisplay} に渡して復元する）
 */
export function applyPdfColumnHide(
  rootEl: HTMLElement,
  allColumnKeys: readonly string[],
  selectedColumnKeys: ReadonlySet<string>,
): HTMLElement[] {
  const hidden: HTMLElement[] = [];
  for (const key of allColumnKeys) {
    if (selectedColumnKeys.has(key)) continue;
    const els = rootEl.querySelectorAll<HTMLElement>(`[data-col="${key}"]`);
    els.forEach((el) => {
      el.style.display = "none";
      hidden.push(el);
    });
  }
  return hidden;
}

/**
 * {@link applyPdfColumnHide} で非表示にした要素群の `display` を空文字に戻して復元する。
 * 空配列を渡しても安全（no-op）。idempotent（複数回呼んでも安全）。
 */
export function restorePdfColumnDisplay(hiddenElements: HTMLElement[]): void {
  hiddenElements.forEach((el) => {
    el.style.display = "";
  });
}
