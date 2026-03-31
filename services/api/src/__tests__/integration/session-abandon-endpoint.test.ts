/**
 * POST /lesson-sessions/:sessionId/abandon エンドポイントのHTTPレベルテスト
 *
 * sendBeacon互換（認証なし）エンドポイントの動作検証:
 * - 204: activeセッションの正常放棄
 * - 404: 存在しないセッションID
 * - 409: 非activeセッション
 * - 認証ヘッダーなしでもアクセス可能
 */

import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

describe("POST /lesson-sessions/:sessionId/abandon", () => {
  let request: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let lessonId: string;
  let courseId: string;
  let videoId: string;

  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });

    const course = await ds.createCourse({
      name: "Test Course",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    courseId = course.id;

    const lesson = await ds.createLesson({
      courseId,
      title: "Test Lesson",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    lessonId = lesson.id;

    const video = await ds.createVideo({
      lessonId,
      courseId,
      sourceType: "gcs",
      gcsPath: "test/video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    videoId = video.id;

    // 認証なしのアプリ（sendBeacon互換テスト）
    const app = express();
    app.use(cors());
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantContext = { tenantId: "test-tenant", isDemo: false };
      req.dataSource = ds;
      // req.user を意図的に設定しない（sendBeaconは認証ヘッダーを送れない）
      next();
    });
    app.use(createSharedRouter());

    request = supertest(app);
  });

  it("returns 204 for an active session (no auth required)", async () => {
    const session = await ds.createLessonSession({
      userId: "user1",
      lessonId,
      courseId,
      videoId,
      sessionToken: "token-1",
      status: "active",
      entryAt: new Date().toISOString(),
      exitAt: null,
      exitReason: null,
      deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: false,
      quizAttemptId: null,
    });

    const res = await request.post(`/lesson-sessions/${session.id}/abandon`);
    expect(res.status).toBe(204);

    // DBで状態を確認
    const updated = await ds.getLessonSession(session.id);
    expect(updated!.status).toBe("abandoned");
    expect(updated!.exitReason).toBe("browser_close");
  });

  it("returns 404 for nonexistent session ID", async () => {
    const res = await request.post("/lesson-sessions/nonexistent-uuid/abandon");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 409 for already completed session", async () => {
    const session = await ds.createLessonSession({
      userId: "user1",
      lessonId,
      courseId,
      videoId,
      sessionToken: "token-1",
      status: "completed",
      entryAt: new Date().toISOString(),
      exitAt: new Date().toISOString(),
      exitReason: "quiz_submitted",
      deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: true,
      quizAttemptId: "attempt-1",
    });

    const res = await request.post(`/lesson-sessions/${session.id}/abandon`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_not_active");
  });

  it("returns 409 for already abandoned session (idempotency guard)", async () => {
    const session = await ds.createLessonSession({
      userId: "user1",
      lessonId,
      courseId,
      videoId,
      sessionToken: "token-1",
      status: "active",
      entryAt: new Date().toISOString(),
      exitAt: null,
      exitReason: null,
      deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: false,
      quizAttemptId: null,
    });

    // 1回目: 成功
    const res1 = await request.post(`/lesson-sessions/${session.id}/abandon`);
    expect(res1.status).toBe(204);

    // 2回目: 409（既にabandoned）
    const res2 = await request.post(`/lesson-sessions/${session.id}/abandon`);
    expect(res2.status).toBe(409);
  });
});
