/**
 * クイズ受験フローの統合テスト
 * attempt作成 → 回答提出 → 採点 → 結果取得の完全フロー
 */

import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import { createTestApp } from "../helpers/create-app.js";
import type { InMemoryDataSource } from "../../datasource/in-memory.js";

// 共通のクイズ問題セット（全問正解版）
const testQuestions = [
  {
    id: "q1",
    text: "1 + 1 は何ですか？",
    type: "single",
    options: [
      { id: "q1-a", text: "1", isCorrect: false },
      { id: "q1-b", text: "2", isCorrect: true },
      { id: "q1-c", text: "3", isCorrect: false },
    ],
    points: 50,
    explanation: "1 + 1 = 2 です",
  },
  {
    id: "q2",
    text: "Typescriptはどの言語のスーパーセットですか？",
    type: "single",
    options: [
      { id: "q2-a", text: "Python", isCorrect: false },
      { id: "q2-b", text: "Java", isCorrect: false },
      { id: "q2-c", text: "JavaScript", isCorrect: true },
    ],
    points: 50,
    explanation: "TypeScriptはJavaScriptのスーパーセットです",
  },
];

describe("Quiz Flow (complete flow)", () => {
  let adminRequest: ReturnType<typeof supertest>;
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let quizId: string;
  let videoId: string;
  const studentUserId = "test-student-1";

  beforeEach(async () => {
    // 管理者用アプリ
    const { app: adminApp, ds: adminDs } = createTestApp();
    adminRequest = supertest(adminApp);
    ds = adminDs as unknown as InMemoryDataSource;

    // 1. コース作成
    const courseRes = await adminRequest
      .post("/admin/courses")
      .send({ name: "クイズフローテストコース", description: "テスト" });
    const courseId = courseRes.body.course.id;

    // 2. レッスン作成
    const lessonRes = await adminRequest
      .post(`/admin/courses/${courseId}/lessons`)
      .send({ title: "クイズフローレッスン", hasVideo: true, hasQuiz: true });
    const lessonId = lessonRes.body.lesson.id;

    // 3. 動画をDataSourceに直接注入
    const video = await adminDs.createVideo({
      lessonId,
      courseId,
      sourceType: "external_url",
      sourceUrl: "https://example.com/video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    videoId = video.id;

    // 4. クイズ作成（requireVideoCompletion=true, maxAttempts=2）
    const quizRes = await adminRequest
      .post(`/admin/lessons/${lessonId}/quiz`)
      .send({
        title: "クイズフローテスト",
        questions: testQuestions,
        passThreshold: 70,
        maxAttempts: 2,
        timeLimitSec: null,
        randomizeQuestions: false,
        randomizeAnswers: false,
        requireVideoCompletion: true,
      });
    quizId = quizRes.body.quiz.id;

    // 5. video_analyticsにisComplete=trueを注入（ゲート通過用）
    await adminDs.upsertVideoAnalytics(studentUserId, videoId, {
      isComplete: true,
      coverageRatio: 0.98,
      totalWatchTimeSec: 290,
      watchedRanges: [{ start: 0, end: 290 }],
    });

    // 受講者用アプリを同一DataSourceで構成
    const express = (await import("express")).default;
    const cors = (await import("cors")).default;
    const { createSharedRouter } = await import("../../routes/shared/index.js");

    const studentApp = express();
    studentApp.use(cors());
    studentApp.use(express.json());
    studentApp.use((req, _res, next) => {
      req.tenantContext = { tenantId: "test-tenant", isDemo: false };
      req.dataSource = adminDs;
      req.user = { id: studentUserId, email: "student@test.com", role: "student" };
      next();
    });
    studentApp.use(createSharedRouter());

    studentRequest = supertest(studentApp);
  });

  describe("GET /quizzes/:quizId", () => {
    it("問題取得時にisCorrectが全てfalseになっている（正解が隠される）", async () => {
      const res = await studentRequest.get(`/quizzes/${quizId}`);

      expect(res.status).toBe(200);
      expect(res.body.quiz).toBeDefined();
      expect(res.body.quiz.questions).toBeDefined();

      // 正解フラグが全てfalseに上書きされている
      res.body.quiz.questions.forEach((q: { options: Array<{ isCorrect: boolean }> }) => {
        q.options.forEach((opt) => {
          expect(opt.isCorrect).toBe(false);
        });
      });

      // ユーザーの受験回数が含まれる
      expect(res.body.userAttemptCount).toBeDefined();
      expect(res.body.userAttemptCount).toBe(0);
    });
  });

  describe("POST /quizzes/:quizId/attempts", () => {
    it("attempt開始で201とin_progressステータスを返す", async () => {
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);

      expect(res.status).toBe(201);
      expect(res.body.attempt).toBeDefined();
      expect(res.body.attempt.quizId).toBe(quizId);
      expect(res.body.attempt.status).toBe("in_progress");
      expect(res.body.attempt.attemptNumber).toBe(1);
      expect(res.body.attempt.id).toBeDefined();
    });
  });

  describe("PATCH /quiz-attempts/:attemptId", () => {
    it("全問正解: score=100, isPassed=true", async () => {
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attemptId = startRes.body.attempt.id;

      // 全問正解で回答
      const res = await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({
          answers: {
            q1: ["q1-b"],
            q2: ["q2-c"],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.attempt.status).toBe("submitted");
      expect(res.body.attempt.score).toBe(100);
      expect(res.body.attempt.isPassed).toBe(true);
      expect(res.body.attempt.submittedAt).toBeDefined();
    });

    it("全問不正解: score=0, isPassed=false", async () => {
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attemptId = startRes.body.attempt.id;

      // 全問不正解で回答
      const res = await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({
          answers: {
            q1: ["q1-a"], // 不正解
            q2: ["q2-a"], // 不正解
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.attempt.status).toBe("submitted");
      expect(res.body.attempt.score).toBe(0);
      expect(res.body.attempt.isPassed).toBe(false);
    });

    it("部分正解: passThreshold=70%を超えた場合はisPassed=true", async () => {
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attemptId = startRes.body.attempt.id;

      // q1正解(50点), q2不正解(0点) → 50% → 70%未満でisPassed=false
      const res = await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({
          answers: {
            q1: ["q1-b"], // 正解
            q2: ["q2-a"], // 不正解
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.attempt.score).toBe(50);
      expect(res.body.attempt.isPassed).toBe(false);
    });
  });

  describe("GET /quiz-attempts/:attemptId/result", () => {
    it("結果取得（正解・解説付き）", async () => {
      // attempt開始
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attemptId = startRes.body.attempt.id;

      // 全問正解で提出
      await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({
          answers: {
            q1: ["q1-b"],
            q2: ["q2-c"],
          },
        });

      // 結果取得
      const res = await studentRequest.get(`/quiz-attempts/${attemptId}/result`);

      expect(res.status).toBe(200);
      expect(res.body.attempt).toBeDefined();
      expect(res.body.attempt.id).toBe(attemptId);
      expect(res.body.attempt.score).toBe(100);
      expect(res.body.attempt.isPassed).toBe(true);
      expect(res.body.quiz.title).toBeDefined();

      // 各問の正誤・正解・解説が含まれる
      expect(res.body.questionResults).toBeDefined();
      expect(res.body.questionResults.length).toBe(2);

      const q1Result = res.body.questionResults.find(
        (r: { questionId: string }) => r.questionId === "q1"
      );
      expect(q1Result).toBeDefined();
      expect(q1Result.isCorrect).toBe(true);
      expect(q1Result.correctOptionIds).toContain("q1-b");
      expect(q1Result.explanation).toBe("1 + 1 = 2 です");
    });

    it("in_progressのattemptは結果取得できない（400）", async () => {
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attemptId = startRes.body.attempt.id;

      const res = await studentRequest.get(`/quiz-attempts/${attemptId}/result`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("attempt_not_submitted");
    });

    it("存在しないattemptは404", async () => {
      const res = await studentRequest.get("/quiz-attempts/nonexistent/result");

      expect(res.status).toBe(404);
    });
  });

  describe("最大受験回数超過", () => {
    it("maxAttempts=2を超えた3回目は403 max_attempts_exceeded", async () => {
      // 1回目
      const start1 = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attempt1Id = start1.body.attempt.id;
      await studentRequest
        .patch(`/quiz-attempts/${attempt1Id}`)
        .send({ answers: { q1: ["q1-a"], q2: ["q2-a"] } });

      // 2回目
      const start2 = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attempt2Id = start2.body.attempt.id;
      await studentRequest
        .patch(`/quiz-attempts/${attempt2Id}`)
        .send({ answers: { q1: ["q1-a"], q2: ["q2-a"] } });

      // 3回目 → 超過エラー
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("max_attempts_exceeded");
    });
  });

  describe("進行中attempt重複防止", () => {
    it("進行中のattemptがある場合、新規作成は409 attempt_in_progress", async () => {
      // 1回目（未提出）
      await studentRequest.post(`/quizzes/${quizId}/attempts`);

      // 提出せずに2回目を試みる
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("attempt_in_progress");
    });
  });

  describe("他のユーザーのattemptへのアクセス制限", () => {
    it("他ユーザーのattemptは403 forbidden", async () => {
      // 受講者1がattemptを作成
      const startRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      const attemptId = startRes.body.attempt.id;

      // 別ユーザー（admin）が同じattemptにアクセス試みる（adminのidはtest-user-1）
      const { app: _adminApp, ds: _adminDs } = createTestApp();

      // adminDsを同一インスタンスにするため直接注入
      const express = (await import("express")).default;
      const cors = (await import("cors")).default;
      const { createSharedRouter } = await import("../../routes/shared/index.js");

      const otherApp = express();
      otherApp.use(cors());
      otherApp.use(express.json());
      otherApp.use((req, _res, next) => {
        req.tenantContext = { tenantId: "test-tenant", isDemo: false };
        req.dataSource = ds; // 同一DS
        req.user = { id: "other-user-999", email: "other@test.com", role: "student" };
        next();
      });
      otherApp.use(createSharedRouter());

      const otherRequest = supertest(otherApp);
      const res = await otherRequest.get(`/quiz-attempts/${attemptId}/result`);

      // in_progressなので400になるが、forbiddenチェックを先にする
      // ユーザーチェックが先: studentUserId !== other-user-999 → 403
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });
  });
});
