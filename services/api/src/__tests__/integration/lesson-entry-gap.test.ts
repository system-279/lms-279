/**
 * F1: レッスン入室最小間隔（ADR-027 ケースG）の統合テスト。
 *
 * `getOrCreateSessionWithGapCheck` / `previewEntryCooldown` を InMemoryDataSource 経由で
 * 直接検証する（ADR-028「InMemoryDataSource中心の統合テスト」準拠、lesson-session.test.ts と同方針）。
 * HTTP ルート（POST /lesson-sessions の 409 `entry_too_soon` レスポンス形状）は末尾で別途検証する。
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import supertest from "supertest";
import { createTestApp } from "../helpers/create-app.js";
import {
  getOrCreateSessionWithGapCheck,
  previewEntryCooldown,
  createSyntheticCompletedSession,
} from "../../services/lesson-session.js";

const GAP_MS = 60000;

describe("F1 lesson entry gap", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  async function setupCourseWithTwoLessons() {
    const course = await ds.createCourse({
      name: "Test Course",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    const lessonA = await ds.createLesson({
      courseId: course.id,
      title: "Lesson A",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    const lessonB = await ds.createLesson({
      courseId: course.id,
      title: "Lesson B",
      order: 2,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    return { course, lessonA, lessonB };
  }

  describe("boundary values (59999 / 60000 / 60001)", () => {
    it("blocks at 59999ms gap (just under the 60000ms threshold)", async () => {
      const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
      const exitAt = new Date("2026-08-20T09:00:00.000Z");
      await ds.createLessonSession({
        userId: "user-1",
        lessonId: lessonA.id,
        courseId: course.id,
        videoId: "v1",
        sessionToken: "t1",
        status: "completed",
        entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
        exitAt: exitAt.toISOString(),
        exitReason: "quiz_submitted",
        deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: true,
        quizAttemptId: null,
      });

      const now = new Date(exitAt.getTime() + 59999);
      const outcome = await getOrCreateSessionWithGapCheck(
        ds, "user-1", lessonB.id, course.id, "v2", "t2", now
      );
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind === "blocked") {
        expect(outcome.retryAfterMs).toBe(1);
        expect(outcome.previousLessonId).toBe(lessonA.id);
      }
    });

    it("allows at exactly 60000ms gap (strict inequality gap<gapMs, gap===threshold is allowed)", async () => {
      const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
      const exitAt = new Date("2026-08-20T09:00:00.000Z");
      await ds.createLessonSession({
        userId: "user-1",
        lessonId: lessonA.id,
        courseId: course.id,
        videoId: "v1",
        sessionToken: "t1",
        status: "completed",
        entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
        exitAt: exitAt.toISOString(),
        exitReason: "quiz_submitted",
        deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: true,
        quizAttemptId: null,
      });

      const now = new Date(exitAt.getTime() + 60000);
      const outcome = await getOrCreateSessionWithGapCheck(
        ds, "user-1", lessonB.id, course.id, "v2", "t2", now
      );
      expect(outcome.kind).toBe("allowed");
    });

    it("allows at 60001ms gap (just over the threshold)", async () => {
      const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
      const exitAt = new Date("2026-08-20T09:00:00.000Z");
      await ds.createLessonSession({
        userId: "user-1",
        lessonId: lessonA.id,
        courseId: course.id,
        videoId: "v1",
        sessionToken: "t1",
        status: "completed",
        entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
        exitAt: exitAt.toISOString(),
        exitReason: "quiz_submitted",
        deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: true,
        quizAttemptId: null,
      });

      const now = new Date(exitAt.getTime() + 60001);
      const outcome = await getOrCreateSessionWithGapCheck(
        ds, "user-1", lessonB.id, course.id, "v2", "t2", now
      );
      expect(outcome.kind).toBe("allowed");
    });
  });

  it("exempts same-lesson re-entry even when the gap would otherwise block (ADR-027 正規動線)", async () => {
    const { course, lessonA } = await setupCourseWithTwoLessons();
    const exitAt = new Date("2026-08-20T09:00:00.000Z");
    await ds.createLessonSession({
      userId: "user-1",
      lessonId: lessonA.id,
      courseId: course.id,
      videoId: "v1",
      sessionToken: "t1",
      status: "force_exited",
      entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
      exitAt: exitAt.toISOString(),
      exitReason: "time_limit",
      deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: false,
      quizAttemptId: null,
    });

    // 同一レッスンへ即座に再入室（gap=1ms）
    const now = new Date(exitAt.getTime() + 1);
    const outcome = await getOrCreateSessionWithGapCheck(
      ds, "user-1", lessonA.id, course.id, "v1", "t2", now
    );
    expect(outcome.kind).toBe("allowed");
  });

  it("allows entry when the previous session is in a different course (F1 scope = same course only)", async () => {
    const { course, lessonA } = await setupCourseWithTwoLessons();
    const otherCourse = await ds.createCourse({
      name: "Other Course",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    const otherLesson = await ds.createLesson({
      courseId: otherCourse.id,
      title: "Other Lesson",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });

    const exitAt = new Date("2026-08-20T09:00:00.000Z");
    await ds.createLessonSession({
      userId: "user-1",
      lessonId: lessonA.id,
      courseId: course.id,
      videoId: "v1",
      sessionToken: "t1",
      status: "completed",
      entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
      exitAt: exitAt.toISOString(),
      exitReason: "quiz_submitted",
      deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: true,
      quizAttemptId: null,
    });

    // 別コースへの入室は gap=1ms でも許可（コース跨ぎは F1 対象外）
    const now = new Date(exitAt.getTime() + 1);
    const outcome = await getOrCreateSessionWithGapCheck(
      ds, "user-1", otherLesson.id, otherCourse.id, "v2", "t2", now
    );
    expect(outcome.kind).toBe("allowed");
  });

  it("allows entry when the only prior session in the course is synthetic (converted timestamp, excluded from gap check)", async () => {
    const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
    // synthetic session: 換算 exitAt が「今」に極めて近い値になり得る
    await createSyntheticCompletedSession(ds, {
      userId: "user-1",
      lessonId: lessonA.id,
      courseId: course.id,
      videoId: "v1",
      quizAttemptId: "attempt-1",
      startedAt: "2026-08-20T08:58:00.000Z",
      submittedAt: "2026-08-20T08:59:00.000Z",
      videoDurationSec: 60, // exitAt = 08:58:00 + 60s(video) + 60s(quiz) = 09:00:00
    });

    const now = new Date("2026-08-20T09:00:00.500Z"); // synthetic exitAt からわずか500ms後
    const outcome = await getOrCreateSessionWithGapCheck(
      ds, "user-1", lessonB.id, course.id, "v2", "t2", now
    );
    expect(outcome.kind).toBe("allowed");
  });

  it("fails open (allows entry) when the DataSource throws during the gap-check transaction", async () => {
    const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
    const exitAt = new Date("2026-08-20T09:00:00.000Z");
    await ds.createLessonSession({
      userId: "user-1",
      lessonId: lessonA.id,
      courseId: course.id,
      videoId: "v1",
      sessionToken: "t1",
      status: "completed",
      entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
      exitAt: exitAt.toISOString(),
      exitReason: "quiz_submitted",
      deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: true,
      quizAttemptId: null,
    });

    const spy = vi
      .spyOn(ds, "createSessionWithGapCheck")
      .mockRejectedValueOnce(new Error("simulated transaction failure"));

    // gap は本来 1ms でブロックされるはずだが、transaction 失敗時は fail-open で許可される
    const now = new Date(exitAt.getTime() + 1);
    const outcome = await getOrCreateSessionWithGapCheck(
      ds, "user-1", lessonB.id, course.id, "v2", "t2", now
    );
    expect(outcome.kind).toBe("allowed");
    spy.mockRestore();
  });

  describe("previewEntryCooldown (read-only, GET /lesson-sessions/active 用)", () => {
    it("returns blocked=true with the same retryAfterMs as the atomic check, without creating a session", async () => {
      const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
      const exitAt = new Date("2026-08-20T09:00:00.000Z");
      await ds.createLessonSession({
        userId: "user-1",
        lessonId: lessonA.id,
        courseId: course.id,
        videoId: "v1",
        sessionToken: "t1",
        status: "completed",
        entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
        exitAt: exitAt.toISOString(),
        exitReason: "quiz_submitted",
        deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: true,
        quizAttemptId: null,
      });

      const now = new Date(exitAt.getTime() + 10000);
      const preview = await previewEntryCooldown(ds, "user-1", lessonB.id, course.id, now);
      expect(preview.blocked).toBe(true);
      expect(preview.retryAfterMs).toBe(GAP_MS - 10000);
      expect(preview.previousLessonId).toBe(lessonA.id);

      // session が作成されていないことを確認
      const sessions = await ds.getLessonSessionsByUserAndCourse("user-1", course.id);
      expect(sessions).toHaveLength(1);
    });

    it("returns blocked=false when an active session already exists for the requested lesson", async () => {
      const { course, lessonA } = await setupCourseWithTwoLessons();
      await ds.createLessonSession({
        userId: "user-1",
        lessonId: lessonA.id,
        courseId: course.id,
        videoId: "v1",
        sessionToken: "t1",
        status: "active",
        entryAt: new Date().toISOString(),
        exitAt: null,
        exitReason: null,
        deadlineAt: new Date(Date.now() + 7200000).toISOString(),
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: false,
        quizAttemptId: null,
      });

      const preview = await previewEntryCooldown(ds, "user-1", lessonA.id, course.id);
      expect(preview.blocked).toBe(false);
    });
  });

  describe("concurrent requests (transaction atomicity)", () => {
    it("prevents two concurrent gap-check requests to different lessons from both being allowed", async () => {
      const { course, lessonA, lessonB } = await setupCourseWithTwoLessons();
      const lessonC = await ds.createLesson({
        courseId: course.id,
        title: "Lesson C",
        order: 3,
        hasVideo: true,
        hasQuiz: true,
        videoUnlocksPrior: false,
      });

      // 前提: ユーザーは lessonA を退室したばかり
      const exitAt = new Date("2026-08-20T09:00:00.000Z");
      await ds.createLessonSession({
        userId: "user-1",
        lessonId: lessonA.id,
        courseId: course.id,
        videoId: "v1",
        sessionToken: "t1",
        status: "completed",
        entryAt: new Date(exitAt.getTime() - 600000).toISOString(),
        exitAt: exitAt.toISOString(),
        exitReason: "quiz_submitted",
        deadlineAt: new Date(exitAt.getTime() + 7200000).toISOString(),
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: true,
        quizAttemptId: null,
      });

      const now = new Date(exitAt.getTime() + 5000); // gap=5s、閾値未満でブロックされるべき
      // 同時に lessonB と lessonC へ入室リクエスト（InMemory 実装は await を挟まないため
      // Promise.all でも実質逐次実行されるが、両方が「まだ session が無い状態」を前提に
      // ブロックされることを検証する = 非同期処理の中で状態を先読みして両方許可してしまう
      // バグ（check→create 非原子性）を再現・検知するテスト）
      const [outcomeB, outcomeC] = await Promise.all([
        getOrCreateSessionWithGapCheck(ds, "user-1", lessonB.id, course.id, "v2", "t2", now),
        getOrCreateSessionWithGapCheck(ds, "user-1", lessonC.id, course.id, "v3", "t3", now),
      ]);

      expect(outcomeB.kind).toBe("blocked");
      expect(outcomeC.kind).toBe("blocked");

      // どちらの session も作成されていないこと（突破されていない）
      const sessions = await ds.getLessonSessionsByUserAndCourse("user-1", course.id);
      expect(sessions.filter((s) => s.status === "active")).toHaveLength(0);
    });
  });
});

describe("F1 lesson entry gap: HTTP route (POST /lesson-sessions)", () => {
  const originalGapMs = process.env.LESSON_ENTRY_GAP_MS;

  afterEach(() => {
    if (originalGapMs === undefined) {
      delete process.env.LESSON_ENTRY_GAP_MS;
    } else {
      process.env.LESSON_ENTRY_GAP_MS = originalGapMs;
    }
  });

  it("returns 409 entry_too_soon with retryAfterMs/nextEntryAllowedAt/previousLessonId when blocked", async () => {
    const { app, ds } = createTestApp();
    const request = supertest(app);

    const courseRes = await request
      .post("/admin/courses")
      .send({ name: "Gap Test Course", description: "desc" });
    const courseId = courseRes.body.course.id;

    const lessonARes = await request
      .post(`/admin/courses/${courseId}/lessons`)
      .send({ title: "Lesson A", hasVideo: true, hasQuiz: true });
    const lessonBRes = await request
      .post(`/admin/courses/${courseId}/lessons`)
      .send({ title: "Lesson B", hasVideo: true, hasQuiz: true });

    const now = new Date();
    await ds.createLessonSession({
      userId: "test-user-1",
      lessonId: lessonARes.body.lesson.id,
      courseId,
      videoId: "v1",
      sessionToken: "t1",
      status: "completed",
      entryAt: new Date(now.getTime() - 600000).toISOString(),
      exitAt: now.toISOString(),
      exitReason: "quiz_submitted",
      deadlineAt: new Date(now.getTime() + 7200000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: true,
      quizAttemptId: null,
    });

    const res = await request.post("/lesson-sessions").send({
      lessonId: lessonBRes.body.lesson.id,
      videoId: "v2",
      sessionToken: "t2",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("entry_too_soon");
    expect(res.body.details.previousLessonId).toBe(lessonARes.body.lesson.id);
    expect(typeof res.body.details.retryAfterMs).toBe("number");
    expect(typeof res.body.details.nextEntryAllowedAt).toBe("string");
  });
});
