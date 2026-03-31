import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import {
  createSession,
  getOrCreateSession,
  forceExitSession,
  abandonSession,
  completeSession,
  validateSessionDeadline,
  handleStaleSession,
} from "../../services/lesson-session.js";

describe("lesson-session service", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  // テスト用にレッスンとビデオを作成するヘルパー
  async function setupLesson() {
    const course = await ds.createCourse({
      name: "Test Course",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    const lesson = await ds.createLesson({
      courseId: course.id,
      title: "Test Lesson",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    const video = await ds.createVideo({
      lessonId: lesson.id,
      courseId: course.id,
      sourceType: "gcs",
      gcsPath: "test/video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    return { course, lesson, video };
  }

  describe("createSession", () => {
    it("creates an active session with correct fields", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      expect(session.status).toBe("active");
      expect(session.userId).toBe("user1");
      expect(session.lessonId).toBe(lesson.id);
      expect(session.videoId).toBe(video.id);
      expect(session.sessionToken).toBe("token-1");
      expect(session.exitAt).toBeNull();
      expect(session.exitReason).toBeNull();
      expect(session.sessionVideoCompleted).toBe(false);
      expect(session.longestPauseSec).toBe(0);
    });

    it("sets deadlineAt to 2 hours after entryAt", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      const entry = new Date(session.entryAt).getTime();
      const deadline = new Date(session.deadlineAt).getTime();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      expect(deadline - entry).toBe(twoHoursMs);
    });
  });

  describe("getOrCreateSession", () => {
    it("returns existing active session if one exists", async () => {
      const { lesson, video } = await setupLesson();
      const created = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const result = await getOrCreateSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-2");

      expect(result.session.id).toBe(created.id);
      expect(result.created).toBe(false);
    });

    it("creates new session if none exists", async () => {
      const { lesson, video } = await setupLesson();
      const result = await getOrCreateSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      expect(result.session.status).toBe("active");
      expect(result.created).toBe(true);
    });
  });

  describe("forceExitSession", () => {
    it("sets status to force_exited with reason", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const exited = await forceExitSession(ds, session.id, "pause_timeout");

      expect(exited.status).toBe("force_exited");
      expect(exited.exitReason).toBe("pause_timeout");
      expect(exited.exitAt).toBeTruthy();
    });

    it("works with time_limit reason", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const exited = await forceExitSession(ds, session.id, "time_limit");

      expect(exited.exitReason).toBe("time_limit");
    });
  });

  describe("completeSession", () => {
    it("sets status to completed with quiz attempt ID", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const completed = await completeSession(ds, session.id, "attempt-123");

      expect(completed.status).toBe("completed");
      expect(completed.exitReason).toBe("quiz_submitted");
      expect(completed.quizAttemptId).toBe("attempt-123");
      expect(completed.exitAt).toBeTruthy();
    });
  });

  describe("validateSessionDeadline", () => {
    it("returns true for session within deadline", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      expect(validateSessionDeadline(session)).toBe(true);
    });

    it("returns false for expired session", () => {
      const pastDeadline = new Date(Date.now() - 1000).toISOString();
      const session = {
        id: "test",
        userId: "user1",
        lessonId: "lesson1",
        courseId: "course1",
        videoId: "video1",
        sessionToken: "token",
        status: "active" as const,
        entryAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        exitAt: null,
        exitReason: null,
        deadlineAt: pastDeadline,
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: false,
        quizAttemptId: null,
        createdAt: "",
        updatedAt: "",
      };

      expect(validateSessionDeadline(session)).toBe(false);
    });
  });

  describe("abandonSession", () => {
    it("sets status to abandoned with browser_close reason", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const abandoned = await abandonSession(ds, session.id);

      expect(abandoned.status).toBe("abandoned");
      expect(abandoned.exitReason).toBe("browser_close");
      expect(abandoned.exitAt).toBeTruthy();
    });

    it("does NOT reset lesson data (unlike forceExitSession)", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 学習データを作成
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.5,
        isComplete: false,
        watchedRanges: [{ start: 0, end: 150 }],
        totalWatchTimeSec: 150,
        seekCount: 0,
        suspiciousFlags: [],
      });

      await abandonSession(ds, session.id);

      // video_analyticsがリセットされていないことを確認
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).not.toBeNull();
      expect(analytics!.coverageRatio).toBe(0.5);
    });

    it("allows creating a new session after abandoning", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await abandonSession(ds, session.id);

      // abandoned後は getActiveLessonSession が null を返すため新規作成可能
      const active = await ds.getActiveLessonSession("user1", lesson.id);
      expect(active).toBeNull();

      const newSession = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-2");
      expect(newSession.id).not.toBe(session.id);
      expect(newSession.status).toBe("active");
    });
  });

  describe("handleStaleSession", () => {
    it("force-exits an expired active session", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 手動でdeadlineAtを過去に設定
      await ds.updateLessonSession(session.id, {
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });

      const stale = await ds.getLessonSession(session.id);
      const result = await handleStaleSession(ds, stale!);

      expect(result.status).toBe("force_exited");
      expect(result.exitReason).toBe("time_limit");
    });

    it("returns session as-is if not expired", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      const result = await handleStaleSession(ds, session);
      expect(result.status).toBe("active");
    });
  });
});
