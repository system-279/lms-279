import { describe, it, expect } from "vitest";
import { findLatestCourseExit, evaluateEntryGap } from "../lesson-entry-gap.js";
import type { LessonSession } from "../../types/entities.js";

type MinimalSession = Pick<LessonSession, "lessonId" | "exitAt" | "isSynthetic">;

function session(overrides: Partial<MinimalSession>): MinimalSession {
  return {
    lessonId: "lesson-x",
    exitAt: null,
    isSynthetic: false,
    ...overrides,
  };
}

describe("findLatestCourseExit", () => {
  it("picks the session with the maximum exitAt among multiple terminal sessions (not first/last-in-array)", () => {
    const sessions = [
      session({ lessonId: "lesson-A", exitAt: "2026-08-20T08:00:00.000Z" }),
      session({ lessonId: "lesson-C", exitAt: "2026-08-20T09:00:00.000Z" }), // 最新
      session({ lessonId: "lesson-B", exitAt: "2026-08-20T08:30:00.000Z" }),
    ];
    const now = new Date("2026-08-20T09:00:30.000Z").getTime();
    const result = findLatestCourseExit(sessions, now);
    expect(result).toEqual({
      exitMs: new Date("2026-08-20T09:00:00.000Z").getTime(),
      lessonId: "lesson-C",
    });
  });

  it("ignores synthetic sessions even when their exitAt is more recent than a real session", () => {
    const sessions = [
      session({ lessonId: "lesson-A", exitAt: "2026-08-20T08:00:00.000Z" }),
      session({ lessonId: "lesson-B", exitAt: "2026-08-20T09:00:00.000Z", isSynthetic: true }),
    ];
    const now = new Date("2026-08-20T09:00:30.000Z").getTime();
    const result = findLatestCourseExit(sessions, now);
    expect(result?.lessonId).toBe("lesson-A");
  });

  it("ignores sessions with no exitAt", () => {
    const sessions = [
      session({ lessonId: "lesson-A", exitAt: null }),
      session({ lessonId: "lesson-B", exitAt: "2026-08-20T08:00:00.000Z" }),
    ];
    const result = findLatestCourseExit(sessions, Date.now());
    expect(result?.lessonId).toBe("lesson-B");
  });

  it("ignores sessions whose exitAt is in the future relative to now (clock-skew guard)", () => {
    const now = new Date("2026-08-20T08:00:00.000Z").getTime();
    const sessions = [
      session({ lessonId: "lesson-A", exitAt: "2026-08-20T07:00:00.000Z" }),
      session({ lessonId: "lesson-B", exitAt: "2026-08-20T09:00:00.000Z" }), // future
    ];
    const result = findLatestCourseExit(sessions, now);
    expect(result?.lessonId).toBe("lesson-A");
  });

  it("returns null when there are no eligible sessions", () => {
    expect(findLatestCourseExit([], Date.now())).toBeNull();
  });
});

describe("evaluateEntryGap", () => {
  it("blocks when the latest exit among several prior sessions is a different lesson within the gap", () => {
    const sessions = [
      session({ lessonId: "lesson-A", exitAt: "2026-08-20T08:00:00.000Z" }),
      session({ lessonId: "lesson-B", exitAt: "2026-08-20T09:00:00.000Z" }), // 最新の退室
    ];
    const now = new Date("2026-08-20T09:00:10.000Z").getTime();
    const decision = evaluateEntryGap(sessions, "lesson-C", now, 60000);
    expect(decision.blocked).toBe(true);
    expect(decision.previousLessonId).toBe("lesson-B");
    expect(decision.retryAfterMs).toBe(50000);
  });

  it("allows when the latest exit among several prior sessions is the requested lesson itself", () => {
    const sessions = [
      session({ lessonId: "lesson-A", exitAt: "2026-08-20T08:00:00.000Z" }),
      session({ lessonId: "lesson-B", exitAt: "2026-08-20T09:00:00.000Z" }), // 最新 = 入室先と同一
    ];
    const now = new Date("2026-08-20T09:00:10.000Z").getTime();
    const decision = evaluateEntryGap(sessions, "lesson-B", now, 60000);
    expect(decision.blocked).toBe(false);
  });

  it("allows when no prior session exists in the course", () => {
    const decision = evaluateEntryGap([], "lesson-A", Date.now(), 60000);
    expect(decision.blocked).toBe(false);
  });
});
