/**
 * Issue #458 (PR #459): 要素内の全テキストを範囲選択する。
 * CopyButton の writeText 失敗時の fallback 動線として、`<code>` 要素をクリックで
 * 全選択 → 手動コピー可能にする。
 *
 * `window.getSelection()` が null の環境 (iframe sandbox 等) や、`document.createRange`
 * が DOMException を投げる古い WebView では silent にスキップしつつ console.error で
 * observability を残す (CSS の `user-select: text` / `select-all` で最低限 fallback)。
 */
import { extractErrorName } from "@/lib/error-utils";

export function selectAllInElement(element: HTMLElement): void {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel) {
    console.error("[dom-select] window.getSelection unavailable");
    return;
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (err) {
    console.error("[dom-select] range selection failed", {
      errorName: extractErrorName(err),
    });
  }
}
