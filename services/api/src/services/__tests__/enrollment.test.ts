import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkQuizAccess,
  checkVideoAccess,
  calculateDefaultDeadlines,
} from "../enrollment.js";
import type { CourseEnrollmentSetting } from "../../types/entities.js";

const NOW = new Date("2026-04-02T10:00:00Z");

function makeSetting(overrides: Partial<CourseEnrollmentSetting> = {}): CourseEnrollmentSetting {
  return {
    id: "course1",
    courseId: "course1",
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

describe("calculateDefaultDeadlines", () => {
  it("enrolledAtから2ヶ月と1年を計算（期限は日末23:59:59.999Z）", () => {
    const result = calculateDefaultDeadlines("2026-04-01T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2026-06-01T23:59:59.999Z");
    expect(result.videoAccessUntil).toBe("2027-04-01T23:59:59.999Z");
  });

  it("月末の日付でも正しくクランプ（1月31日 + 2ヶ月 = 3月31日）", () => {
    const result = calculateDefaultDeadlines("2026-01-31T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2026-03-31T23:59:59.999Z");
  });

  it("12月31日 + 2ヶ月 = 翌年2月28日（月末クランプ）", () => {
    const result = calculateDefaultDeadlines("2026-12-31T00:00:00Z");
    // 2027年は非閏年 → 2月28日
    expect(result.quizAccessUntil).toBe("2027-02-28T23:59:59.999Z");
    expect(result.videoAccessUntil).toBe("2027-12-31T23:59:59.999Z");
  });

  it("閏年2月29日 + 1年 = 非閏年2月28日（月末クランプ）", () => {
    const result = calculateDefaultDeadlines("2024-02-29T00:00:00Z");
    // 2025年は非閏年 → 2月28日
    expect(result.videoAccessUntil).toBe("2025-02-28T23:59:59.999Z");
    // 2024-02-29 + 2ヶ月 = 2024-04-29
    expect(result.quizAccessUntil).toBe("2024-04-29T23:59:59.999Z");
  });

  it("年末の日付でも正しく計算", () => {
    const result = calculateDefaultDeadlines("2026-12-15T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2027-02-15T23:59:59.999Z");
    expect(result.videoAccessUntil).toBe("2027-12-15T23:59:59.999Z");
  });
});
