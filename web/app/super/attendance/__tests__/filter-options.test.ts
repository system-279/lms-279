import { describe, expect, it } from "vitest";
import { compareStringsNaturally, sortFilterOptionsByLabel } from "../_helpers/filter-options";

describe("sortFilterOptionsByLabel", () => {
  it("レッスン番号のような数字接頭辞を自然順（1,2,...,10）で並べる", () => {
    const options = [
      { value: "l10", label: "10.Google Workspaceの各アプリケーションの連携" },
      { value: "l1", label: "1. Googleワークスペースの概要とChromeの活用" },
      { value: "l2", label: "2.Googleドライブの活用" },
      { value: "l9", label: "9.Googleフォームの活用（基礎編1）" },
    ];

    const sorted = sortFilterOptionsByLabel(options);

    expect(sorted.map((o) => o.value)).toEqual(["l1", "l2", "l9", "l10"]);
  });

  it("日本語ラベルは五十音順で並べる", () => {
    const options = [
      { value: "c", label: "たなか" },
      { value: "a", label: "あさの" },
      { value: "b", label: "さとう" },
    ];

    const sorted = sortFilterOptionsByLabel(options);

    expect(sorted.map((o) => o.value)).toEqual(["a", "b", "c"]);
  });

  it("空配列を渡すと空配列を返す", () => {
    expect(sortFilterOptionsByLabel([])).toEqual([]);
  });

  it("元の配列を破壊しない", () => {
    const options = [
      { value: "l2", label: "2.Googleドライブの活用" },
      { value: "l1", label: "1. Googleワークスペースの概要" },
    ];
    const original = [...options];

    sortFilterOptionsByLabel(options);

    expect(options).toEqual(original);
  });
});

describe("compareStringsNaturally", () => {
  it("レッスン名の数字接頭辞を自然順で比較する（列ヘッダソート用）", () => {
    const labels = [
      "10.Google Workspaceの各アプリケーションの連携",
      "1. Googleワークスペースの概要とChromeの活用",
      "2.Googleドライブの活用",
      "9.Googleフォームの活用（基礎編1）",
    ];

    const sorted = [...labels].sort(compareStringsNaturally);

    expect(sorted).toEqual([
      "1. Googleワークスペースの概要とChromeの活用",
      "2.Googleドライブの活用",
      "9.Googleフォームの活用（基礎編1）",
      "10.Google Workspaceの各アプリケーションの連携",
    ]);
  });
});
