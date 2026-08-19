/**
 * テスト任意化 Stage 5(ケースD厳格化): GET /lessons/:lessonId の `sessionRequired` フィールドの
 * 統合テスト（second opinion レビュー指摘反映）。
 *
 * この値は SessionRulesNotice の「有効セッション必須」注意書きの表示条件そのもの。
 * 計算式 `isQuizActiveSessionRequired() && lesson.hasVideo && lesson.hasQuiz` の
 * フラグ×動画有無×テスト有無の交差をHTTPレスポンス単位で直接検証する
 * （これまでFEのモックテストでしか検証されておらず、実サーバー応答は未検証だった）。
 */

import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

describe("テスト任意化 Stage 5: GET /lessons/:lessonId sessionRequired", () => {
  const originalFlag = process.env.QUIZ_REQUIRE_ACTIVE_SESSION;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.QUIZ_REQUIRE_ACTIVE_SESSION;
    } else {
      process.env.QUIZ_REQUIRE_ACTIVE_SESSION = originalFlag;
    }
  });

  async function setupLesson(hasVideo: boolean, hasQuiz: boolean) {
    const ds = new InMemoryDataSource({ readOnly: false });
    const course = await ds.createCourse({
      name: "sessionRequired検証コース",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    const lesson = await ds.createLesson({
      courseId: course.id,
      title: "sessionRequired検証レッスン",
      order: 1,
      hasVideo,
      hasQuiz,
      videoUnlocksPrior: false,
    });

    const app = express();
    app.use(cors());
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantContext = { tenantId: "test-tenant", isDemo: false };
      req.dataSource = ds;
      req.user = { id: "student-1", email: "student@test.com", role: "student" };
      next();
    });
    app.use(createSharedRouter());

    return { request: supertest(app), lessonId: lesson.id };
  }

  it("flag=true(default), hasVideo=true, hasQuiz=true → sessionRequired=true", async () => {
    delete process.env.QUIZ_REQUIRE_ACTIVE_SESSION;
    const { request, lessonId } = await setupLesson(true, true);
    const res = await request.get(`/lessons/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionRequired).toBe(true);
  });

  it("flag=true(default), hasVideo=true, hasQuiz=false → sessionRequired=false（テストが存在しないレッスンで誤案内しない）", async () => {
    delete process.env.QUIZ_REQUIRE_ACTIVE_SESSION;
    const { request, lessonId } = await setupLesson(true, false);
    const res = await request.get(`/lessons/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionRequired).toBe(false);
  });

  it("flag=true(default), hasVideo=false, hasQuiz=true → sessionRequired=false（動画なしレッスンは免除）", async () => {
    delete process.env.QUIZ_REQUIRE_ACTIVE_SESSION;
    const { request, lessonId } = await setupLesson(false, true);
    const res = await request.get(`/lessons/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionRequired).toBe(false);
  });

  it("flag=false, hasVideo=true, hasQuiz=true → sessionRequired=false", async () => {
    process.env.QUIZ_REQUIRE_ACTIVE_SESSION = "false";
    const { request, lessonId } = await setupLesson(true, true);
    const res = await request.get(`/lessons/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionRequired).toBe(false);
  });
});
