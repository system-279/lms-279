/**
 * Issue #533: active session なしで quiz が合格提出された場合の合成 session 作成の統合テスト
 *
 * 真因 (services/api/src/routes/shared/quiz-attempts.ts:292-294):
 *   設計上、activeSession=null でもテスト提出を許可するため、合格時に lesson_sessions に
 *   痕跡が残らず、user_progress と乖離していた。本テストは合成 session 作成パスを検証する。
 *
 * AC1.1 (作成): activeSession=null + 合格 → synthetic_{attemptId} で session 作成
 * AC1.2 (不変): activeSession あり → 既存 completeSession path、合成 session 作成なし (既存テストで担保)
 * AC1.3 (冪等): 同 attempt の再呼び出しで重複作成なし
 * AC1.4 (失敗): video 解決不可 → 提出 200 維持、合成 session 作成 skip
 * AC1.5 (在室中): activeSession=null + 不合格 → 合成 session 作成しない
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";
import { logger } from "../../utils/logger.js";

const passingQuestions = [
  {
    id: "q1",
    text: "テスト問題",
    type: "single" as const,
    options: [
      { id: "q1-a", text: "正解", isCorrect: true },
      { id: "q1-b", text: "不正解", isCorrect: false },
    ],
    points: 100,
    explanation: "解説",
  },
];

describe("Issue #533: 合成 session 作成 (activeSession=null 時の合格提出)", () => {
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let quizId: string;
  let lessonId: string;
  let courseId: string;
  let videoId: string;
  const studentUserId = "test-student-synthetic";

  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });

    const course = await ds.createCourse({
      name: "合成セッションテスト",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    courseId = course.id;

    const lesson = await ds.createLesson({
      courseId,
      title: "合成セッションレッスン",
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

    const quiz = await ds.createQuiz({
      lessonId,
      courseId,
      title: "合成セッションテスト",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: passingQuestions,
    });
    quizId = quiz.id;

    const studentApp = express();
    studentApp.use(cors());
    studentApp.use(express.json());
    studentApp.use((req, _res, next) => {
      req.tenantContext = { tenantId: "test-tenant", isDemo: false };
      req.dataSource = ds;
      req.user = { id: studentUserId, email: "student@test.com", role: "student" };
      next();
    });
    studentApp.use(createSharedRouter());

    studentRequest = supertest(studentApp);
  });

  // ============================================================
  // AC1.1: activeSession=null + 合格 → 合成 session 作成
  // ============================================================
  it("AC1.1: activeSession=null + 合格提出で synthetic_{attemptId} の session が作成される", async () => {
    const attemptRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
    expect(attemptRes.status).toBe(201);
    const attemptId = attemptRes.body.attempt.id;

    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptId}`)
      .send({ answers: { q1: ["q1-a"] } });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.attempt.status).toBe("submitted");
    expect(submitRes.body.attempt.isPassed).toBe(true);

    // 合成 session が作成されているか
    const syntheticId = `synthetic_${attemptId}`;
    const synthetic = await ds.getLessonSession(syntheticId);
    expect(synthetic).not.toBeNull();
    expect(synthetic!.isSynthetic).toBe(true);
    expect(synthetic!.status).toBe("completed");
    expect(synthetic!.exitReason).toBe("quiz_submitted");
    expect(synthetic!.userId).toBe(studentUserId);
    expect(synthetic!.lessonId).toBe(lessonId);
    expect(synthetic!.courseId).toBe(courseId);
    expect(synthetic!.videoId).toBe(videoId);
    expect(synthetic!.quizAttemptId).toBe(attemptId);
    expect(synthetic!.entryAt).toBeTruthy(); // attempt.startedAt
    expect(synthetic!.exitAt).toBeTruthy(); // attempt.submittedAt
  });

  // ============================================================
  // AC1.3: 冪等性 — 重複呼び出しで session が複製されない
  // ============================================================
  it("AC1.3: 同 attemptId で createSyntheticCompletedSession が再呼び出しされても重複作成されない", async () => {
    // 1 回目: 通常 flow
    const attemptRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
    const attemptId = attemptRes.body.attempt.id;
    await studentRequest
      .patch(`/quiz-attempts/${attemptId}`)
      .send({ answers: { q1: ["q1-a"] } });

    const allBefore = (await ds.getLessonSessionsByCourse(courseId)).filter(
      (s) => s.id === `synthetic_${attemptId}`,
    );
    expect(allBefore.length).toBe(1);

    // 2 回目: helper を直接呼び出して冪等性確認
    const { createSyntheticCompletedSession } = await import("../../services/lesson-session.js");
    const { created } = await createSyntheticCompletedSession(ds, {
      userId: studentUserId,
      lessonId,
      courseId,
      videoId,
      quizAttemptId: attemptId,
      startedAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
    });
    expect(created).toBe(false); // 既存ヒット

    const allAfter = (await ds.getLessonSessionsByCourse(courseId)).filter(
      (s) => s.id === `synthetic_${attemptId}`,
    );
    expect(allAfter.length).toBe(1); // 重複なし
  });

  // ============================================================
  // AC1.4: video 解決不可 → 提出 200 維持、合成 session 作成 skip、logger.error で監視可能
  // ============================================================
  it("AC1.4: video が存在しないレッスンで提出 200 + 合成 session 作成 skip + structured logger.error 出力", async () => {
    // logger.error をスパイし、AC「logger.error で監視可能」要件を機械的に検証
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    // 別レッスン (video なし) + quiz を作る
    const lessonNoVideo = await ds.createLesson({
      courseId,
      title: "video なしレッスン",
      order: 2,
      hasVideo: false,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    const quizNoVideo = await ds.createQuiz({
      lessonId: lessonNoVideo.id,
      courseId,
      title: "video なしクイズ",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: passingQuestions,
    });

    const attemptRes = await studentRequest
      .post(`/quizzes/${quizNoVideo.id}/attempts`)
      .send({});
    const attemptId = attemptRes.body.attempt.id;

    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptId}`)
      .send({ answers: { q1: ["q1-a"] } });

    expect(submitRes.status).toBe(200); // 提出は成功
    expect(submitRes.body.attempt.isPassed).toBe(true);

    // 合成 session は作成されない (video 解決不可で skip)
    const synthetic = await ds.getLessonSession(`synthetic_${attemptId}`);
    expect(synthetic).toBeNull();

    // user_progress は更新される (合成 session 失敗と独立)
    const progress = await ds.getUserProgress(studentUserId, lessonNoVideo.id);
    expect(progress?.quizPassed).toBe(true);

    // logger.error が eventType=quiz_synthetic_session_video_missing で呼ばれた
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Synthetic session skipped"),
      expect.objectContaining({
        eventType: "quiz_synthetic_session_video_missing",
        attemptId,
        lessonId: lessonNoVideo.id,
        userId: studentUserId,
      }),
    );

    loggerErrorSpy.mockRestore();
  });

  // ============================================================
  // AC1.5: activeSession=null + 不合格 → 合成 session 作成しない (合格時のみ)
  // ============================================================
  it("AC1.5: 不合格提出では合成 session は作成されない (合格時のみ)", async () => {
    const attemptRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
    const attemptId = attemptRes.body.attempt.id;

    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptId}`)
      .send({ answers: { q1: ["q1-b"] } }); // 誤答

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.attempt.isPassed).toBe(false);

    const synthetic = await ds.getLessonSession(`synthetic_${attemptId}`);
    expect(synthetic).toBeNull();
  });

  // ============================================================
  // AC1.2 補強: active session ありの既存 path は不変 (合成 session 作成しない)
  // ============================================================
  it("AC1.2: active session 経由の合格提出では合成 session は作成されない", async () => {
    // セッション作成
    const sessionRes = await studentRequest.post("/lesson-sessions").send({
      lessonId,
      videoId,
      sessionToken: "test-token-active",
    });
    expect(sessionRes.status).toBe(201);
    const activeSessionId = sessionRes.body.session.id;

    const attemptRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
    const attemptId = attemptRes.body.attempt.id;

    await studentRequest
      .patch(`/quiz-attempts/${attemptId}`)
      .send({ answers: { q1: ["q1-a"] } });

    // 既存 session が completed
    const original = await ds.getLessonSession(activeSessionId);
    expect(original!.status).toBe("completed");
    expect(original!.exitReason).toBe("quiz_submitted");
    expect(original!.isSynthetic).toBeUndefined();

    // 合成 session は作成されない
    const synthetic = await ds.getLessonSession(`synthetic_${attemptId}`);
    expect(synthetic).toBeNull();
  });
});
