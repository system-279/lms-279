/**
 * 動画完了ゲートの統合テスト（ADR-019）
 * 動画視聴完了前はクイズにアクセスできないことを確認する
 */

import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import { createTestApp } from "../helpers/create-app.js";
import type { InMemoryDataSource } from "../../datasource/in-memory.js";

describe("Video Completion Gate (ADR-019)", () => {
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let quizId: string;
  let videoId: string;
  const studentUserId = "test-student-1";

  beforeEach(async () => {
    // 管理者用アプリでコース・レッスン・動画・クイズをセットアップ
    const { app: adminApp, ds: adminDs } = createTestApp();
    const adminRequest = supertest(adminApp);

    // 受講者用アプリを同一DSで構築するため、adminDSを直接使う
    // (アプリを共有しないが、dsは同じインスタンスを参照するようにする)
    ds = adminDs as unknown as InMemoryDataSource;

    // 1. コース作成
    const courseRes = await adminRequest
      .post("/admin/courses")
      .send({ name: "動画ゲートテストコース", description: "テスト用" });
    const courseId = courseRes.body.course.id;

    // 2. レッスン作成（hasVideo=true, hasQuiz=true）
    const lessonRes = await adminRequest
      .post(`/admin/courses/${courseId}/lessons`)
      .send({ title: "動画ゲートテストレッスン", hasVideo: true, hasQuiz: true });
    const lessonId = lessonRes.body.lesson.id;

    // 3. 動画メタデータをDataSourceに直接注入（GCSサービスをバイパス）
    const video = await adminDs.createVideo({
      lessonId,
      courseId,
      sourceType: "external_url",
      sourceUrl: "https://example.com/test-video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    videoId = video.id;

    // 4. クイズ作成（requireVideoCompletion=true）
    const quizRes = await adminRequest
      .post(`/admin/lessons/${lessonId}/quiz`)
      .send({
        title: "動画ゲートテストクイズ",
        questions: [
          {
            id: "q1",
            text: "テスト問題1",
            type: "single",
            options: [
              { id: "opt1", text: "正解", isCorrect: true },
              { id: "opt2", text: "不正解", isCorrect: false },
            ],
            points: 100,
            explanation: "説明1",
          },
        ],
        passThreshold: 70,
        maxAttempts: 3,
        requireVideoCompletion: true,
      });
    quizId = quizRes.body.quiz.id;

    // 受講者アプリを同一DataSourceで構成
    // adminAppと同じdsを使う受講者アプリを作成するためにインラインで構築
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

  describe("動画未視聴時", () => {
    it("GET /quizzes/:quizId → 403 video_not_completed", async () => {
      const res = await studentRequest.get(`/quizzes/${quizId}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("video_not_completed");
    });

    it("POST /quizzes/:quizId/attempts → 403 video_not_completed", async () => {
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("video_not_completed");
    });
  });

  describe("動画視聴完了後", () => {
    beforeEach(async () => {
      // video_analyticsにisComplete=trueを注入
      // 同じdsインスタンスを参照しているので直接注入
      await ds.upsertVideoAnalytics(studentUserId, videoId, {
        isComplete: true,
        coverageRatio: 0.98,
        totalWatchTimeSec: 290,
        watchedRanges: [{ start: 0, end: 290 }],
      });
    });

    it("GET /quizzes/:quizId → 200（正解なし版クイズ取得成功）", async () => {
      const res = await studentRequest.get(`/quizzes/${quizId}`);

      expect(res.status).toBe(200);
      expect(res.body.quiz).toBeDefined();
      expect(res.body.quiz.id).toBe(quizId);
      // 正解フラグが除去されているか確認
      res.body.quiz.questions.forEach((q: { options: Array<{ isCorrect?: unknown }> }) => {
        q.options.forEach((opt) => {
          expect(opt.isCorrect).toBe(false);
        });
      });
    });

    it("POST /quizzes/:quizId/attempts → 201 attempt作成成功", async () => {
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);

      expect(res.status).toBe(201);
      expect(res.body.attempt).toBeDefined();
      expect(res.body.attempt.quizId).toBe(quizId);
      expect(res.body.attempt.status).toBe("in_progress");
    });
  });
});
