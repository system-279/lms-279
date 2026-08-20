import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";

describe("LESSON_ENTRY_GAP_MS env var override", () => {
  const original = process.env.LESSON_ENTRY_GAP_MS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LESSON_ENTRY_GAP_MS;
    } else {
      process.env.LESSON_ENTRY_GAP_MS = original;
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function loadModule() {
    vi.resetModules();
    return await import("../lesson-session.js");
  }

  it("falls back to default 60000ms (1分) when env var is not set", async () => {
    delete process.env.LESSON_ENTRY_GAP_MS;
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("respects LESSON_ENTRY_GAP_MS env var override", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "30000";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(30000);
  });

  it("accepts 0 as kill switch (disables the feature, unlike SESSION_DURATION_MS)", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "0";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(0);
  });

  it("falls back to default when env var is non-numeric", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "not-a-number";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is empty string", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is whitespace only", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "   ";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is negative", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "-1000";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("falls back to default when env var is non-integer float", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "60000.5";
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(60000);
  });

  it("accepts a large positive integer (no upper cap by design)", async () => {
    process.env.LESSON_ENTRY_GAP_MS = String(5 * 60 * 1000); // 5min
    const mod = await loadModule();
    expect(mod.LESSON_ENTRY_GAP_MS).toBe(5 * 60 * 1000);
  });

  it("kill switch (LESSON_ENTRY_GAP_MS=0) allows entry that would otherwise be blocked, and skips the transaction entirely", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "0";
    const mod = await loadModule();

    const ds = new InMemoryDataSource({ readOnly: false });
    const course = await ds.createCourse({
      name: "Kill Switch Course", description: null, status: "published",
      lessonOrder: [], passThreshold: 80, createdBy: "admin",
    });
    const lessonA = await ds.createLesson({
      courseId: course.id, title: "Lesson A", order: 1,
      hasVideo: true, hasQuiz: true, videoUnlocksPrior: false,
    });
    const lessonB = await ds.createLesson({
      courseId: course.id, title: "Lesson B", order: 2,
      hasVideo: true, hasQuiz: true, videoUnlocksPrior: false,
    });
    const exitAt = new Date("2026-08-20T09:00:00.000Z");
    await ds.createLessonSession({
      userId: "user-1", lessonId: lessonA.id, courseId: course.id,
      videoId: "v1", sessionToken: "t1", status: "completed",
      entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
      exitAt: exitAt.toISOString(), exitReason: "quiz_submitted",
      deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
      pauseStartedAt: null, longestPauseSec: 0,
      sessionVideoCompleted: true, quizAttemptId: null,
    });

    const spy = vi.spyOn(ds, "createSessionWithGapCheck");
    // gap=1ms なら本来ブロックされるはずだが、kill switch により判定自体が省略される
    const now = new Date(exitAt.getTime() + 1);
    const outcome = await mod.getOrCreateSessionWithGapCheck(
      ds, "user-1", lessonB.id, course.id, "v2", "t2", now
    );
    expect(outcome.kind).toBe("allowed");
    expect(spy).not.toHaveBeenCalled();

    const preview = await mod.previewEntryCooldown(ds, "user-1", lessonB.id, course.id, now);
    expect(preview.blocked).toBe(false);
  });

  it("logs error when env var is invalid (observability)", async () => {
    process.env.LESSON_ENTRY_GAP_MS = "abc";
    vi.resetModules();
    const loggerMod = await import("../../utils/logger.js");
    const spy = vi.spyOn(loggerMod.logger, "error").mockImplementation(() => loggerMod.logger);
    await import("../lesson-session.js");
    expect(spy).toHaveBeenCalledWith(
      "Invalid env duration, falling back to default",
      expect.objectContaining({
        envName: "LESSON_ENTRY_GAP_MS",
        rawValue: "abc",
        errorId: "ENV_DURATION_INVALID",
      })
    );
  });
});
