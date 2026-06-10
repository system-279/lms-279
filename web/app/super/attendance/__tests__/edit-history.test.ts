import { describe, expect, it } from "vitest";
import {
  formatOriginalTooltip,
  hasOriginalSnapshot,
} from "../_helpers/edit-history";

describe("hasOriginalSnapshot", () => {
  it("original あり → true", () => {
    const original = { entryAt: "2026-06-09T01:00:00.000Z", exitAt: null, quizScore: 100, quizPassed: true };
    expect(hasOriginalSnapshot({ original })).toBe(true);
  });

  it("original なし (undefined) → false", () => {
    expect(hasOriginalSnapshot({ original: undefined })).toBe(false);
  });

  it("original が空オブジェクト風だが存在する → true", () => {
    const original = { entryAt: null, exitAt: null, quizScore: null, quizPassed: null };
    expect(hasOriginalSnapshot({ original })).toBe(true);
  });

  it("型述語: true 分岐で original の non-null 型推論が効く (Evaluator 指摘の non-null assertion 削除)", () => {
    const record = {
      original: { entryAt: null, exitAt: null, quizScore: 100, quizPassed: true },
    };
    if (hasOriginalSnapshot(record)) {
      // この分岐内では record.original の type narrowing が効く
      const score: number | null = record.original.quizScore;
      expect(score).toBe(100);
    }
  });
});

describe("formatOriginalTooltip", () => {
  it("全フィールドありの正常系: 入退室時刻 / 点数 / 合否 が表示", () => {
    const tooltip = formatOriginalTooltip({
      entryAt: "2026-06-09T01:30:00.000Z", // JST 10:30
      exitAt: "2026-06-09T03:45:00.000Z",  // JST 12:45
      quizScore: 100,
      quizPassed: true,
    });
    expect(tooltip).toContain("編集前:");
    expect(tooltip).toContain("入室 10:30");
    expect(tooltip).toContain("退室 12:45");
    expect(tooltip).toContain("100点");
    expect(tooltip).toContain("合格");
  });

  it("不合格 → '不合格' 表示", () => {
    const tooltip = formatOriginalTooltip({
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T02:00:00.000Z",
      quizScore: 50,
      quizPassed: false,
    });
    expect(tooltip).toContain("50点");
    expect(tooltip).toContain("不合格");
  });

  it("quizPassed=null (未受験) → '未受験' 表示", () => {
    const tooltip = formatOriginalTooltip({
      entryAt: "2026-06-09T01:00:00.000Z",
      exitAt: "2026-06-09T02:00:00.000Z",
      quizScore: null,
      quizPassed: null,
    });
    expect(tooltip).toContain("未受験");
    expect(tooltip).toContain("—");
  });

  it("entryAt / exitAt null → '—' 表示 (在室中/未確定セッションの編集等)", () => {
    const tooltip = formatOriginalTooltip({
      entryAt: null,
      exitAt: null,
      quizScore: 80,
      quizPassed: true,
    });
    expect(tooltip).toContain("入室 —");
    expect(tooltip).toContain("退室 —");
  });

  it("JST タイムゾーンで時刻表示 (UTC からの変換)", () => {
    // UTC 00:00 → JST 09:00
    const tooltip = formatOriginalTooltip({
      entryAt: "2026-06-09T00:00:00.000Z",
      exitAt: "2026-06-09T00:30:00.000Z",
      quizScore: 100,
      quizPassed: true,
    });
    expect(tooltip).toContain("入室 09:00");
    expect(tooltip).toContain("退室 09:30");
  });
});
