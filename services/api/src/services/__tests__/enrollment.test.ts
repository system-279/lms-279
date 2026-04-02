import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkQuizAccess,
  checkVideoAccess,
  calculateDefaultDeadlines,
} from "../enrollment.js";
import type { Enrollment } from "../../types/entities.js";

const NOW = new Date("2026-04-02T10:00:00Z");

function makeEnrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    id: "user1_course1",
    userId: "user1",
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
    const enrollment = makeEnrollment({
      quizAccessUntil: "2026-06-01T00:00:00Z",
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: true });
  });

  it("期限切れはアクセス拒否", () => {
    const enrollment = makeEnrollment({
      quizAccessUntil: "2026-03-01T00:00:00Z",
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "quiz_access_expired" });
  });

  it("期限ちょうどはアクセス拒否", () => {
    const enrollment = makeEnrollment({
      quizAccessUntil: NOW.toISOString(),
    });
    const result = checkQuizAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "quiz_access_expired" });
  });

  it("無効な日付データはアクセス拒否（データ破損防御）", () => {
    const enrollment = makeEnrollment({
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
    const enrollment = makeEnrollment({
      videoAccessUntil: "2027-06-01T00:00:00Z",
    });
    const result = checkVideoAccess(enrollment);
    expect(result).toEqual({ allowed: true });
  });

  it("期限切れはアクセス拒否", () => {
    const enrollment = makeEnrollment({
      videoAccessUntil: "2026-01-01T00:00:00Z",
    });
    const result = checkVideoAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "video_access_expired" });
  });

  it("無効な日付データはアクセス拒否（データ破損防御）", () => {
    const enrollment = makeEnrollment({
      videoAccessUntil: "not-a-date",
    });
    const result = checkVideoAccess(enrollment);
    expect(result).toEqual({ allowed: false, reason: "invalid_deadline_data" });
  });
});

describe("calculateDefaultDeadlines", () => {
  it("enrolledAtから2ヶ月と1年を計算", () => {
    const result = calculateDefaultDeadlines("2026-04-01T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2026-06-01T00:00:00.000Z");
    expect(result.videoAccessUntil).toBe("2027-04-01T00:00:00.000Z");
  });

  it("月末の日付でも正しく計算（1月31日 + 2ヶ月 = 3月31日）", () => {
    const result = calculateDefaultDeadlines("2026-01-31T00:00:00Z");
    // JS Dateの挙動: 1/31 + 2ヶ月 = 3/31（3月は31日あるのでOK）
    expect(new Date(result.quizAccessUntil).getMonth()).toBe(2); // 3月 (0-indexed)
  });

  it("年末の日付でも正しく計算", () => {
    const result = calculateDefaultDeadlines("2026-12-15T00:00:00Z");
    expect(result.quizAccessUntil).toBe("2027-02-15T00:00:00.000Z");
    expect(result.videoAccessUntil).toBe("2027-12-15T00:00:00.000Z");
  });
});
