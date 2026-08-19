/**
 * Issue #533: createSyntheticCompletedSession のユニットテスト
 *
 * テスト任意化 Stage 5(ケースD厳格化、セカンドオピニオン反映): 旧
 * `quiz-attempt-synthetic-session.test.ts` の AC13(videoDurationSec hard guard) /
 * AC2(exitAt算出) / AC1.3(冪等性) は、いずれも本関数を直接呼び出すだけで HTTP を経由しない
 * ため、サービス層のユニットテストへ移設した（HTTP経由の受験フローは Stage 5 で
 * QUIZ_REQUIRE_ACTIVE_SESSION のゲート対象になり、この関数自体の検証には不要な複雑さになるため）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSyntheticCompletedSession } from "../lesson-session.js";

describe("createSyntheticCompletedSession", () => {
  let ds: InMemoryDataSource;
  let lessonId: string;
  let courseId: string;
  let videoId: string;
  const userId = "test-student-synthetic-unit";

  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });
    const course = await ds.createCourse({
      name: "合成セッションユニットテスト",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    courseId = course.id;
    const lesson = await ds.createLesson({
      courseId,
      title: "合成セッションユニットテストレッスン",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    lessonId = lesson.id;
    const video = await ds.createVideo({
      lessonId,
      courseId,
      sourceType: "external_url",
      sourceUrl: "https://example.com/video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    videoId = video.id;
  });

  // ============================================================
  // AC13: videoDurationSec hard guard
  // ============================================================
  it("videoDurationSec が 0 → throw", async () => {
    await expect(
      createSyntheticCompletedSession(ds, {
        userId,
        lessonId,
        courseId,
        videoId,
        quizAttemptId: "attempt_guard_zero",
        startedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        videoDurationSec: 0,
      })
    ).rejects.toThrow(/invalid videoDurationSec/);
  });

  it("videoDurationSec が負数 → throw", async () => {
    await expect(
      createSyntheticCompletedSession(ds, {
        userId,
        lessonId,
        courseId,
        videoId,
        quizAttemptId: "attempt_guard_neg",
        startedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        videoDurationSec: -1,
      })
    ).rejects.toThrow(/invalid videoDurationSec/);
  });

  it("videoDurationSec が NaN → throw", async () => {
    await expect(
      createSyntheticCompletedSession(ds, {
        userId,
        lessonId,
        courseId,
        videoId,
        quizAttemptId: "attempt_guard_nan",
        startedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        videoDurationSec: NaN,
      })
    ).rejects.toThrow(/invalid videoDurationSec/);
  });

  it("videoDurationSec が Infinity → throw", async () => {
    await expect(
      createSyntheticCompletedSession(ds, {
        userId,
        lessonId,
        courseId,
        videoId,
        quizAttemptId: "attempt_guard_inf",
        startedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        videoDurationSec: Infinity,
      })
    ).rejects.toThrow(/invalid videoDurationSec/);
  });

  // ============================================================
  // AC2: exitAt の正確な算出値 (動画 60 分 + テスト 5 分 → 65 分後)
  // ============================================================
  it("exitAt = startedAt + videoDurationSec*1000 + quizDurationMs を正確に算出", async () => {
    const startedAt = "2026-05-30T01:00:00.000Z";
    const submittedAt = "2026-05-30T01:05:00.000Z"; // quiz 5 分
    const videoDurationSec = 60 * 60; // 60 分

    const { session, created } = await createSyntheticCompletedSession(ds, {
      userId,
      lessonId,
      courseId,
      videoId,
      quizAttemptId: "attempt_ac2",
      startedAt,
      submittedAt,
      videoDurationSec,
    });
    expect(created).toBe(true);
    expect(session.entryAt).toBe(startedAt); // 維持
    // exitAt = startedAt + 60min (動画) + 5min (テスト) = startedAt + 65min
    expect(session.exitAt).toBe("2026-05-30T02:05:00.000Z");
  });

  // ============================================================
  // AC1.3: 冪等性 — 同一 quizAttemptId の再呼び出しで session が複製されない
  // ============================================================
  it("同一 quizAttemptId で再呼び出ししても重複作成されない（冪等）", async () => {
    const params = {
      userId,
      lessonId,
      courseId,
      videoId,
      quizAttemptId: "attempt_idempotent",
      startedAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
      videoDurationSec: 300,
    };

    const first = await createSyntheticCompletedSession(ds, params);
    expect(first.created).toBe(true);

    const second = await createSyntheticCompletedSession(ds, params);
    expect(second.created).toBe(false); // 既存ヒット
    expect(second.session.id).toBe(first.session.id);

    const all = (await ds.getLessonSessionsByCourse(courseId)).filter(
      (s) => s.id === `synthetic_${params.quizAttemptId}`
    );
    expect(all.length).toBe(1); // 重複なし
  });
});
