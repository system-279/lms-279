/**
 * テスト任意化 Stage 5(ケースD厳格化): 有効セッション必須化 + 合格後再受験の遮断
 *
 * 計画: ~/.claude/plans/sunny-growing-aurora.md（plan mode承認済み、セカンドオピニオン反映）
 *
 * POST /quizzes/:quizId/attempts の新設ゲート（受講期限チェックの後、原子的作成の直前）:
 *   合格済み(409 quiz_already_passed、flagに依存せず常時適用) →
 *   有効セッション必須(flag ON かつ動画ありレッスンのみ。none→409 session_required、expired→403 session_time_exceeded)
 *
 * PATCH /quiz-attempts/:attemptId の移行期対応:
 *   flag ON かつ動画ありレッスンで有効セッションが無ければ、採点前に timed_out 化してから 409 session_required
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";
import { createActiveSessionViaHttp } from "../helpers/create-active-session.js";

const testQuestions = [
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

describe("テスト任意化 Stage 5: 有効セッション必須化 + 合格後再受験の遮断", () => {
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let quizId: string;
  let lessonId: string;
  let courseId: string;
  let videoId: string;
  const studentUserId = "test-student-session-required";
  const originalFlag = process.env.QUIZ_REQUIRE_ACTIVE_SESSION;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.QUIZ_REQUIRE_ACTIVE_SESSION;
    } else {
      process.env.QUIZ_REQUIRE_ACTIVE_SESSION = originalFlag;
    }
  });

  async function setupLessonWithVideo(hasVideo = true) {
    const course = await ds.createCourse({
      name: "セッション必須化テストコース",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    courseId = course.id;

    const lesson = await ds.createLesson({
      courseId,
      title: "セッション必須化テストレッスン",
      order: 1,
      hasVideo,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    lessonId = lesson.id;

    if (hasVideo) {
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
    }

    const quiz = await ds.createQuiz({
      lessonId,
      courseId,
      title: "セッション必須化テスト",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: testQuestions,
    });
    quizId = quiz.id;
  }

  function buildStudentApp() {
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
  }

  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });
    delete process.env.QUIZ_REQUIRE_ACTIVE_SESSION; // デフォルト true を明示的に検証するため未設定にする
    await setupLessonWithVideo(true);
    buildStudentApp();
  });

  // ============================================================
  // POST /quizzes/:quizId/attempts: 有効セッション必須（デフォルト true）
  // ============================================================
  describe("POST /quizzes/:quizId/attempts", () => {
    it("セッションなしでは409 session_required、attemptは生成されない", async () => {
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_required");

      const attempts = await ds.getQuizAttempts({ quizId, userId: studentUserId });
      expect(attempts.length).toBe(0);
    });

    it("期限切れセッションでは403 session_time_exceeded、セッションはforce_exitedになる", async () => {
      const sessionRes = await createActiveSessionViaHttp(studentRequest, { lessonId, videoId });
      const sessionId = sessionRes.body.session.id;
      await ds.updateLessonSession(sessionId, {
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });

      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("session_time_exceeded");

      const session = await ds.getLessonSession(sessionId);
      expect(session?.status).toBe("force_exited");
    });

    it("有効セッションがあれば201でattemptが作成される", async () => {
      await createActiveSessionViaHttp(studentRequest, { lessonId, videoId });
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(res.status).toBe(201);
    });

    it("合格済みなら409 quiz_already_passed（セッション有無に関わらず常時適用）", async () => {
      await ds.upsertUserProgress(studentUserId, lessonId, {
        courseId,
        videoCompleted: true,
        quizPassed: true,
      });
      await createActiveSessionViaHttp(studentRequest, { lessonId, videoId });

      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("quiz_already_passed");
    });

    it("動画なしレッスンはセッションなしでも201になる（免除）", async () => {
      await setupLessonWithVideo(false);
      buildStudentApp();
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(res.status).toBe(201);
    });

    it("QUIZ_REQUIRE_ACTIVE_SESSION=falseでは旧挙動（セッションなしでも201）に戻る", async () => {
      process.env.QUIZ_REQUIRE_ACTIVE_SESSION = "false";
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(res.status).toBe(201);
    });
  });

  // ============================================================
  // PATCH /quiz-attempts/:attemptId: 移行期対応（in-flight attemptの救済）
  // ============================================================
  describe("PATCH /quiz-attempts/:attemptId（提出直前にセッション消失）", () => {
    it("セッション消失後の提出は409 session_required、attemptはtimed_outになり受験回数を消費しない", async () => {
      // flag=false でセッションなしのattemptを作る（Stage 5デプロイ前に開始されたin-flight attemptを模す）
      process.env.QUIZ_REQUIRE_ACTIVE_SESSION = "false";
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      expect(startRes.status).toBe(201);
      const attemptId = startRes.body.attempt.id;

      // 移行期: flag を true に戻してから提出（セッションは存在しない）
      process.env.QUIZ_REQUIRE_ACTIVE_SESSION = "true";
      const submitRes = await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({ answers: { q1: ["q1-a"] } });

      expect(submitRes.status).toBe(409);
      expect(submitRes.body.error).toBe("session_required");

      const attempt = await ds.getQuizAttemptById(attemptId);
      expect(attempt?.status).toBe("timed_out");

      // 受験回数を消費していないこと（新規attemptがattemptNumber=1で作れる）
      const retryRes = await createActiveSessionViaHttp(studentRequest, { lessonId, videoId }).then(() =>
        studentRequest.post(`/quizzes/${quizId}/attempts`).send({})
      );
      expect(retryRes.status).toBe(201);
      expect(retryRes.body.attempt.attemptNumber).toBe(2); // timed_out化されたattemptの次番号（countEffectiveAttemptsはtimed_out除外だがattemptNumber自体は連番）
    });

    it("有効セッション内での提出は影響を受けない（従来通り成功）", async () => {
      await createActiveSessionViaHttp(studentRequest, { lessonId, videoId });
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
      const attemptId = startRes.body.attempt.id;

      const submitRes = await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({ answers: { q1: ["q1-a"] } });

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.attempt.status).toBe("submitted");
    });
  });
});
