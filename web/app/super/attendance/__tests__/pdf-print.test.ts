/**
 * PDF 出力 (window.print()) DOM 操作 helper のテスト。
 *
 * Issue #252 (PDF 出力カラム選択) のロジックに対する regression catch。
 * jsdom 環境で DOM API を直接操作してカバー。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyPdfColumnHide,
  restorePdfColumnDisplay,
} from "../_helpers/pdf-print";

const ALL_COLUMNS = [
  "userName",
  "courseName",
  "lessonTitle",
  "date",
  "entryAt",
  "exitAt",
  "stayDuration",
  "exitReason",
  "quizScore",
  "quizPassed",
] as const;

/** テーブル構造 (TableHead + 3 行の TableCell) を模した DOM を組み立てる。 */
function buildTable(): HTMLElement {
  const root = document.createElement("div");
  // ヘッダー行 (data-col 付き th 相当の div)
  for (const key of ALL_COLUMNS) {
    const th = document.createElement("div");
    th.setAttribute("data-col", key);
    th.classList.add("th");
    th.textContent = `H:${key}`;
    root.appendChild(th);
  }
  // body 3 行 × 全カラム
  for (let row = 0; row < 3; row += 1) {
    for (const key of ALL_COLUMNS) {
      const td = document.createElement("div");
      td.setAttribute("data-col", key);
      td.classList.add("td");
      td.textContent = `R${row}:${key}`;
      root.appendChild(td);
    }
  }
  return root;
}

function visibleColumns(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-col]"))
    .filter((el) => el.style.display !== "none")
    .map((el) => el.getAttribute("data-col") ?? "")
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

describe("applyPdfColumnHide", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = buildTable();
  });

  it("全カラム選択 → 何も非表示にならず hidden 配列は空", () => {
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, new Set(ALL_COLUMNS));
    expect(hidden).toHaveLength(0);
    expect(visibleColumns(root)).toEqual([...ALL_COLUMNS]);
  });

  it("一部選択解除 → 非選択カラムの全要素 (TableHead + 各 TableCell) が非表示", () => {
    const selected = new Set<string>(["userName", "courseName", "date"]);
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, selected);

    // 非選択 7 カラム × 4 要素 (1 ヘッダー + 3 ボディ) = 28 要素が非表示
    expect(hidden).toHaveLength(28);
    expect(hidden.every((el) => el.style.display === "none")).toBe(true);
    expect(visibleColumns(root)).toEqual(["userName", "courseName", "date"]);
  });

  it("全選択解除 → 全カラム (40 要素) 非表示", () => {
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, new Set());
    expect(hidden).toHaveLength(10 * 4); // 10 cols × 4 (1 head + 3 body)
    expect(visibleColumns(root)).toEqual([]);
  });

  it("data-col 値が存在しないカラムキー指定 → エラーなく無視され他カラムに影響なし", () => {
    const selected = new Set(ALL_COLUMNS);
    const allWithGhost = [...ALL_COLUMNS, "nonexistent_col"];
    const hidden = applyPdfColumnHide(root, allWithGhost, selected);
    expect(hidden).toHaveLength(0);
    expect(visibleColumns(root)).toEqual([...ALL_COLUMNS]);
  });

  it("data-col 重複要素 (TableHead + 複数 body row) → すべて非表示にされ hidden 配列に集約", () => {
    const selected = new Set(ALL_COLUMNS.filter((k) => k !== "quizScore"));
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, selected);
    expect(hidden).toHaveLength(4); // 1 head + 3 body の合計 4 要素
    expect(hidden.every((el) => el.getAttribute("data-col") === "quizScore")).toBe(true);
  });

  it("allColumnKeys の指定順に走査する (TableHead が先頭に来る hidden 配列を保証)", () => {
    // 確認: hidden 配列の順は (col 順) × (DOM 順) になる
    const selected = new Set<string>();
    const allKeys = ["entryAt", "exitAt"] as const;
    const hidden = applyPdfColumnHide(root, allKeys, selected);
    const colsInOrder = hidden.map((el) => el.getAttribute("data-col"));
    // entryAt の 4 要素 → exitAt の 4 要素
    expect(colsInOrder).toEqual([
      "entryAt", "entryAt", "entryAt", "entryAt",
      "exitAt", "exitAt", "exitAt", "exitAt",
    ]);
  });
});

describe("restorePdfColumnDisplay", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = buildTable();
  });

  it("非表示にした全要素の display を空文字に戻す", () => {
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, new Set());
    expect(hidden.every((el) => el.style.display === "none")).toBe(true);

    restorePdfColumnDisplay(hidden);
    expect(hidden.every((el) => el.style.display === "")).toBe(true);
    expect(visibleColumns(root)).toEqual([...ALL_COLUMNS]);
  });

  it("空配列を渡しても安全 (no-op)", () => {
    expect(() => restorePdfColumnDisplay([])).not.toThrow();
  });

  it("idempotent: 復元を 2 回呼んでも DOM 状態が変わらない (afterprint + setTimeout の二重発火対策)", () => {
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, new Set(["userName"]));
    restorePdfColumnDisplay(hidden);
    const beforeStates = hidden.map((el) => el.style.display);

    restorePdfColumnDisplay(hidden);
    const afterStates = hidden.map((el) => el.style.display);

    expect(afterStates).toEqual(beforeStates);
    expect(afterStates.every((d) => d === "")).toBe(true);
  });

  it("一部要素を後から再度非表示にしても、残りの要素には影響なし (DOM 参照の独立性確認)", () => {
    const hidden = applyPdfColumnHide(root, ALL_COLUMNS, new Set(["userName"]));
    restorePdfColumnDisplay(hidden);
    // 再度 1 要素だけ手動で非表示
    hidden[0].style.display = "none";
    expect(hidden[0].style.display).toBe("none");
    expect(hidden.slice(1).every((el) => el.style.display === "")).toBe(true);
  });
});
