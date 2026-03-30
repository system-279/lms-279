/**
 * テスト提出×セッション制限の統合テスト
 *
 * 最もリスクの高い3パスを検証:
 * 1. セッション期限切れ → テスト提出拒否（403）
 * 2. セッションなし → テスト提出は通常通り成功（後方互換）
 * 3. セッションあり+有効期限内 → テスト提出成功+セッション完了（退室打刻）
 */

import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

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

describe("Quiz submission × Session integration", () => {
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let quizId: string;
  let lessonId: string;
  const studentUserId = "test-student-1";

  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });

    // DataSourceに直接データ注入（HTTPリクエスト不要で確実）
    const course = await ds.createCourse({
      name: "セッションテスト",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });

    const lesson = await ds.createLesson({
      courseId: course.id,
      title: "セッションレッスン",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    lessonId = lesson.id;

    await ds.createVideo({
      lessonId,
      courseId: course.id,
      sourceType: "external_url",
      sourceUrl: "https://example.com/video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });

    const quiz = await ds.createQuiz({
      lessonId,
      courseId: course.id,
      title: "セッションテスト",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false, // ゲート無効化（テスト簡略化）
      questions: testQuestions,
    });
    quizId = quiz.id;

    // 受講者アプリ
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

  // =========================================================
  // 1. 後方互換: セッションなしでもテスト提出は成功する
  // =========================================================
  it("セッションなしでもテスト提出が成功する（後方互換）", async () => {
    // attempt作成
    const attemptRes = await studentRequest
      .post(`/quizzes/${quizId}/attempts`)
      .send({});
    expect(attemptRes.status).toBe(201);

    // 提出（セッション作成していない）
    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptRes.body.attempt.id}`)
      .send({
        answers: { q1: ["q1-a"] },
      });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.attempt.status).toBe("submitted");
    expect(submitRes.body.attempt.score).toBeDefined();
  });

  // =========================================================
  // 2. 有効セッション内でテスト提出 → 成功+セッション完了
  // =========================================================
  it("有効セッション内でテスト提出するとセッションが完了する", async () => {
    // セッション作成
    const sessionRes = await studentRequest
      .post("/lesson-sessions")
      .send({
        lessonId,
        videoId: "dummy-video",
        sessionToken: "test-token-1",
      });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.session.id;

    // attempt作成
    const attemptRes = await studentRequest
      .post(`/quizzes/${quizId}/attempts`)
      .send({});
    expect(attemptRes.status).toBe(201);

    // 提出
    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptRes.body.attempt.id}`)
      .send({
        answers: { q1: ["q1-a"] },
      });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.attempt.status).toBe("submitted");

    // セッションが completed になっていること（退室打刻）
    const session = await ds.getLessonSession(sessionId);
    expect(session!.status).toBe("completed");
    expect(session!.exitReason).toBe("quiz_submitted");
    expect(session!.exitAt).toBeTruthy();
    expect(session!.quizAttemptId).toBe(attemptRes.body.attempt.id);
  });

  // =========================================================
  // 3. 期限切れセッションでテスト提出 → 403拒否
  // =========================================================
  it("期限切れセッションではテスト提出が403で拒否される", async () => {
    // セッション作成
    const sessionRes = await studentRequest
      .post("/lesson-sessions")
      .send({
        lessonId,
        videoId: "dummy-video",
        sessionToken: "test-token-2",
      });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.session.id;

    // セッションのdeadlineAtを過去に手動設定（期限切れシミュレーション）
    await ds.updateLessonSession(sessionId, {
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });

    // attempt作成
    const attemptRes = await studentRequest
      .post(`/quizzes/${quizId}/attempts`)
      .send({});
    expect(attemptRes.status).toBe(201);

    // 提出 → 403で拒否されること
    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptRes.body.attempt.id}`)
      .send({
        answers: { q1: ["q1-a"] },
      });

    expect(submitRes.status).toBe(403);
    expect(submitRes.body.error).toBe("session_time_exceeded");

    // セッションが force_exited になっていること
    const session = await ds.getLessonSession(sessionId);
    expect(session!.status).toBe("force_exited");
    expect(session!.exitReason).toBe("time_limit");
  });

  // =========================================================
  // 4. セッション強制退室APIのテスト
  // =========================================================
  it("PATCH /lesson-sessions/:id/force-exit でセッションが強制退室になる", async () => {
    const sessionRes = await studentRequest
      .post("/lesson-sessions")
      .send({
        lessonId,
        videoId: "dummy-video",
        sessionToken: "test-token-3",
      });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.session.id;

    const exitRes = await studentRequest
      .patch(`/lesson-sessions/${sessionId}/force-exit`)
      .send({ reason: "pause_timeout" });

    expect(exitRes.status).toBe(200);
    expect(exitRes.body.session.status).toBe("force_exited");
    expect(exitRes.body.session.exitReason).toBe("pause_timeout");
  });

  // =========================================================
  // 5. 他人のセッションは強制退室できない
  // =========================================================
  it("他人のセッションの強制退室は403で拒否される", async () => {
    // 別ユーザーのセッションを直接作成
    const otherSession = await ds.createLessonSession({
      userId: "other-user",
      lessonId,
      courseId: "dummy",
      videoId: "dummy",
      sessionToken: "other-token",
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

    const exitRes = await studentRequest
      .patch(`/lesson-sessions/${otherSession.id}/force-exit`)
      .send({ reason: "pause_timeout" });

    expect(exitRes.status).toBe(403);
    expect(exitRes.body.error).toBe("forbidden");
  });

  // =========================================================
  // 6. ページリロード時にアクティブセッションを復帰できる
  // =========================================================
  it("GET /lesson-sessions/active でアクティブセッションを復帰できる", async () => {
    const sessionRes = await studentRequest
      .post("/lesson-sessions")
      .send({
        lessonId,
        videoId: "dummy-video",
        sessionToken: "test-token-4",
      });
    expect(sessionRes.status).toBe(201);

    const activeRes = await studentRequest
      .get(`/lesson-sessions/active?lessonId=${lessonId}`);

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.session.status).toBe("active");
    expect(activeRes.body.session.remainingMs).toBeGreaterThan(0);
    expect(activeRes.body.session.deadlineAt).toBeTruthy();
  });

  // =========================================================
  // 7. 期限切れセッションの復帰は404になる
  // =========================================================
  it("期限切れセッションのGET /activeは404を返す", async () => {
    const sessionRes = await studentRequest
      .post("/lesson-sessions")
      .send({
        lessonId,
        videoId: "dummy-video",
        sessionToken: "test-token-5",
      });
    const sessionId = sessionRes.body.session.id;

    await ds.updateLessonSession(sessionId, {
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });

    const activeRes = await studentRequest
      .get(`/lesson-sessions/active?lessonId=${lessonId}`);

    expect(activeRes.status).toBe(404);
    expect(activeRes.body.error).toBe("session_expired");
  });

  // =========================================================
  // 8. maxAttempts到達 + 不合格 → セッションが強制退室される
  // =========================================================
  it("maxAttempts到達で不合格の場合セッションがforce_exitedになる", async () => {
    // maxAttempts=1のクイズを作成
    const quiz1 = await ds.createQuiz({
      lessonId,
      courseId: (await ds.getCourses())[0].id,
      title: "1回限りテスト",
      passThreshold: 100, // 100点必要（不正解で必ず不合格）
      maxAttempts: 1,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: testQuestions,
    });

    // セッション作成
    const sessionRes = await studentRequest
      .post("/lesson-sessions")
      .send({
        lessonId,
        videoId: "dummy-video",
        sessionToken: "test-token-max-attempts",
      });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.session.id;

    // attempt作成
    const attemptRes = await studentRequest
      .post(`/quizzes/${quiz1.id}/attempts`)
      .send({});
    expect(attemptRes.status).toBe(201);

    // 不正解で提出（passThreshold=100なので不合格）
    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptRes.body.attempt.id}`)
      .send({
        answers: { q1: ["q1-b"] }, // 不正解を選択
      });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.attempt.isPassed).toBe(false);

    // セッションがforce_exitedになっていることを確認
    const session = await ds.getLessonSession(sessionId);
    expect(session?.status).toBe("force_exited");
    expect(session?.exitReason).toBe("max_attempts_failed");
    expect(session?.exitAt).toBeTruthy();
  });
});
