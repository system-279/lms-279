import { describe, it, expect, beforeEach, vi } from "vitest";
import { toDate } from "../firestore.js";

// -----------------------------------------------
// toDate() 関数テスト
// -----------------------------------------------

describe("toDate()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:30:00Z"));
  });

  describe("正常系: 各型の変換", () => {
    it("ISO 8601文字列を正しくDate型に変換", () => {
      const isoString = "2024-01-01T00:00:00.000Z";
      const result = toDate(isoString);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("既存の Date型をそのまま返す", () => {
      const date = new Date("2024-01-10T12:30:45.500Z");
      const result = toDate(date);

      expect(result).toBe(date);
      expect(result.toISOString()).toBe("2024-01-10T12:30:45.500Z");
    });

    it("toDate()メソッド持ちのオブジェクト(Firestore Timestamp模擬)を変換", () => {
      const timestamp = {
        toDate: () => new Date("2024-01-05T14:20:10.000Z"),
      };
      const result = toDate(timestamp as unknown as Parameters<typeof toDate>[0]);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe("2024-01-05T14:20:10.000Z");
    });
  });

  describe("エッジケース: 欠損値・不正値", () => {
    it("null は new Date()（現在時刻）にフォールバック", () => {
      const result = toDate(null);

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(new Date("2024-01-15T10:30:00Z").getTime());
    });

    it("undefined は new Date()（現在時刻）にフォールバック", () => {
      const result = toDate(undefined);

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(new Date("2024-01-15T10:30:00Z").getTime());
    });

    it("空文字列は new Date()（現在時刻）にフォールバック", () => {
      const result = toDate("");

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(new Date("2024-01-15T10:30:00Z").getTime());
    });

    it("不正なISO文字列は Invalid Date を返す（ランタイムに検出される）", () => {
      const result = toDate("not-a-valid-date");

      expect(result).toBeInstanceOf(Date);
      expect(Number.isNaN(result.getTime())).toBe(true);
    });
  });

  describe("実装パス検証: toLessonSession への影響", () => {
    it("過去のISO文字列でも変換後は正確な時刻を保持", () => {
      const entryAt = "2024-01-01T09:00:00.000Z";
      const deadlineAt = "2024-01-01T11:00:00.000Z";

      const entryDate = toDate(entryAt);
      const deadlineDate = toDate(deadlineAt);
      const diffMs = deadlineDate.getTime() - entryDate.getTime();

      // 正確に2時間（7200000ミリ秒）
      expect(diffMs).toBe(2 * 60 * 60 * 1000);
    });

    it("型安全性: 文字列型チェックが instanceof Date より先に実行される", () => {
      const isoString = "2024-01-01T00:00:00.000Z";
      // typeof timestamp === "string" チェックで引っかかる
      // instanceof Date に到達しない
      // → toDate() メソッドチェックに到達しない
      const result = toDate(isoString);

      expect(result.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });
  });
});
