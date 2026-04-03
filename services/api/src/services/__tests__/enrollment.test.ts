import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkQuizAccess,
  checkVideoAccess,
  calculateDefaultDeadlines,
} from "../enrollment.js";
import { toDateStrict } from "../../datasource/firestore.js";
import type { TenantEnrollmentSetting } from "../../types/entities.js";

const NOW = new Date("2026-04-02T10:00:00Z");

function makeSetting(overrides: Partial<TenantEnrollmentSetting> = {}): TenantEnrollmentSetting {
  return {
    id: "_config",
    enrolledAt: "2026-03-01T00:00:00Z",
    quizAccessUntil: "2026-05-01T00:00:00Z",
    videoAccessUntil: "2027-03-01T00:00:00Z",
    createdBy: "admin@test.com",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

describe("checkQuizAccess", () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enrollment未登録(null)はアクセス許可（後方互換）", () => {
    const result = checkQuizAccess(null);
    expect(result).toEqual({ allowed: true });
  });

  it("期限内はアクセス許可", () => {
    const enrollment = makeSetting({
      quizAccessUntil: "2026-06-01T00:00:00Z",
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: true });
  });

  it("期限切れはアクセス拒否", () => {
    const enrollment = makeSetting({
      quizAccessUntil: "2026-03-01T00:00:00Z",
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "quiz_access_expired" });
  });

  it("期限ちょうどはアクセス拒否", () => {
    const enrollment = makeSetting({
      quizAccessUntil: NOW.toISOString(),
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "quiz_access_expired" });
  });

  it("無効な日付データはアクセス拒否（データ破損防御）", () => {
    const enrollment = makeSetting({
      quizAccessUntil: "invalid-date",
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "invalid_deadline_data" });
  });
});

describe("checkVideoAccess", () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enrollment未登録(null)はアクセス許可（後方互換）", () => {
    const result = checkVideoAccess(null);
    expect(result).toEqual({ allowed: true });
  });

  it("期限内はアクセス許可", () => {
    const enrollment = makeSetting({
      videoAccessUntil: "2027-06-01T00:00:00Z",
    });
    const result = checkVideoAccess(enrollment);
    expect(result).toEqual({ allowed: true });
  });

  it("期限切れはアクセス拒否", () => {
    const enrollment = makeSetting({
      videoAccessUntil: "2026-01-01T00:00:00Z",
    });
    const result = checkVideoAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "video_access_expired" });
  });

  it("無効な日付データはアクセス拒否（データ破損防御）", () => {
    const enrollment = makeSetting({
      videoAccessUntil: "not-a-date",
    });
    const result = checkVideoAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "invalid_deadline_data" });
  });
});

describe("calculateDefaultDeadlines (JST日末基準)", () => {
  // JST日末 = UTC 14:59:59.999

  it("enrolledAtから2ヶ月と1年を計算（期限はJST日末 = UTC 14:59:59.999）", () => {
    const result = calculateDefaultDeadlines("2026-04-01T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2026-06-01T14:59:59.999Z");
    expect(result.videoAccessUntil).toBe("2027-04-01T14:59:59.999Z");
  });

  it("月末の日付でも正しくクランプ（1月31日 + 2ヶ月 = 3月31日）", () => {
    const result = calculateDefaultDeadlines("2026-01-31T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2026-03-31T14:59:59.999Z");
  });

  it("12月31日 + 2ヶ月 = 翌年2月28日（月末クランプ）", () => {
    const result = calculateDefaultDeadlines("2026-12-31T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2027-02-28T14:59:59.999Z");
    expect(result.videoAccessUntil).toBe("2027-12-31T14:59:59.999Z");
  });

  it("閏年2月29日 + 1年 = 非閏年2月28日（月末クランプ）", () => {
    const result = calculateDefaultDeadlines("2024-02-29T00:00:00Z");
    expect(result.videoAccessUntil).toBe("2025-02-28T14:59:59.999Z");
    expect(result.quizAccessUntil).toBe("2024-04-29T14:59:59.999Z");
  });

  it("無効な日付文字列は例外をスロー", () => {
    expect(() => calculateDefaultDeadlines("not-a-date")).toThrow("invalid enrolledAt");
    expect(() => calculateDefaultDeadlines("")).toThrow("invalid enrolledAt");
  });

  it("年末の日付でも正しく計算", () => {
    const result = calculateDefaultDeadlines("2026-12-15T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2027-02-15T14:59:59.999Z");
    expect(result.videoAccessUntil).toBe("2027-12-15T14:59:59.999Z");
  });
});

describe("toDateStrict", () => {
  it("null入力は例外をスロー", () => {
    expect(() => toDateStrict(null, "enrolledAt")).toThrow(
      "Invalid deadline field: enrolledAt is empty or null"
    );
  });

  it("undefined入力は例外をスロー", () => {
    expect(() => toDateStrict(undefined, "quizAccessUntil")).toThrow(
      "Invalid deadline field: quizAccessUntil is empty or null"
    );
  });

  it("空文字列入力は例外をスロー", () => {
    expect(() => toDateStrict("", "videoAccessUntil")).toThrow(
      "Invalid deadline field: videoAccessUntil is empty or null"
    );
  });

  it("ホワイトスペースのみの文字列は例外をスロー", () => {
    expect(() => toDateStrict("  ", "enrolledAt")).toThrow(
      "Invalid deadline field: enrolledAt is empty or null"
    );
  });

  it("無効な日付形式は例外をスロー", () => {
    expect(() => toDateStrict("invalid-date", "quizAccessUntil")).toThrow(
      /Invalid date format for quizAccessUntil/
    );
  });

  it("無効なDate オブジェクトは例外をスロー", () => {
    const invalidDate = new Date("invalid");
    expect(() => toDateStrict(invalidDate, "enrolledAt")).toThrow(
      "Invalid Date object for enrolledAt"
    );
  });

  it("有効なISO文字列は正常にDate を返す", () => {
    const result = toDateStrict("2026-04-01T00:00:00Z", "enrolledAt");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("有効なDate インスタンスは正常に返す", () => {
    const date = new Date("2026-04-01T00:00:00Z");
    const result = toDateStrict(date, "videoAccessUntil");
    expect(result).toEqual(date);
  });

  it("Firestore Timestampオブジェクトは正常にDate を返す", () => {
    const fakeTimestamp = { toDate: () => new Date("2026-04-01T00:00:00Z") };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = toDateStrict(fakeTimestamp as any, "enrolledAt");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("無効なTimestamp.toDate()結果は例外をスロー", () => {
    const invalidTimestamp = { toDate: () => new Date("invalid") };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => toDateStrict(invalidTimestamp as any, "quizAccessUntil")).toThrow(
      "Invalid Timestamp.toDate() result for quizAccessUntil"
    );
  });
});
