/**
 * 受講期間管理の統合テスト
 * Phase 2 (#220, #221) で追加された期限チェックが HTTP レイヤーで正しく動作することを検証
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import supertest from "supertest";
import { createTestApp } from "../helpers/create-app.js";
import type { InMemoryDataSource } from "../../datasource/in-memory.js";

const testQuestions = [
  {
    id: "q1",
    text: "1 + 1 は？",
    type: "single",
    options: [
      { id: "q1-a", text: "1", isCorrect: false },
      { id: "q1-b", text: "2", isCorrect: true },
    ],
    points: 100,
    explanation: "1 + 1 = 2",
  },
];

const NOW = new Date("2026-04-02T10:00:00Z");
const FUTURE = "2027-01-01T00:00:00Z";
const PAST = "2026-01-01T00:00:00Z";

describe("Enrollment Access Control (integration)", () => {
  let adminRequest: ReturnType<typeof supertest>;
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let courseId: string;
  let lessonId: string;
  let videoId: string;
  let quizId: string;
  const studentUserId = "test-student-1";

  beforeEach(async () => {
    vi.setSystemTime(NOW);

    const { app: adminApp, ds: adminDs } = createTestApp();
    adminRequest = supertest(adminApp);
    ds = adminDs as unknown as InMemoryDataSource;

    // コース作成
    const courseRes = await adminRequest
      .post("/admin/courses")
      .send({ name: "期限テストコース", description: "テスト" });
    courseId = courseRes.body.course.id;

    // レッスン作成
    const lessonRes = await adminRequest
      .post(`/admin/courses/${courseId}/lessons`)
      .send({ title: "期限テストレッスン", hasVideo: true, hasQuiz: true });
    lessonId = lessonRes.body.lesson.id;

    // 動画注入
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

    // ゲート通過用 video_analytics
    await adminDs.upsertVideoAnalytics(studentUserId, videoId, {
      isComplete: true,
      coverageRatio: 0.98,
      totalWatchTimeSec: 290,
      watchedRanges: [{ start: 0, end: 290 }],
    });

    // テスト作成
    const quizRes = await adminRequest
      .post(`/admin/lessons/${lessonId}/quiz`)
      .send({
        title: "期限テスト",
        questions: testQuestions,
        passThreshold: 70,
        maxAttempts: 3,
        timeLimitSec: null,
        randomizeQuestions: false,
        randomizeAnswers: false,
        requireVideoCompletion: true,
      });
    quizId = quizRes.body.quiz.id;

    // 受講者用アプリ（同一 DS）
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

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setEnrollment(quizAccessUntil: string, videoAccessUntil: string) {
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: "2026-01-01T00:00:00Z",
      quizAccessUntil,
      videoAccessUntil,
      createdBy: "admin@test.com",
    });
  }

  // ─── Quiz エンドポイント ───

  describe("GET /quizzes/:quizId", () => {
    it("enrollment 未登録 → 200 OK（後方互換）", async () => {
      const res = await studentRequest.get(`/quizzes/${quizId}`);
      expect(res.status).toBe(200);
      expect(res.body.quiz).toBeDefined();
    });

    it("期限内 → 200 OK", async () => {
      await setEnrollment(FUTURE, FUTURE);
      const res = await studentRequest.get(`/quizzes/${quizId}`);
      expect(res.status).toBe(200);
      expect(res.body.quiz).toBeDefined();
    });

    it("期限切れ → 403 quiz_access_expired", async () => {
      await setEnrollment(PAST, FUTURE);
      const res = await studentRequest.get(`/quizzes/${quizId}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("quiz_access_expired");
    });
  });

  describe("GET /quizzes/by-lesson/:lessonId", () => {
    it("期限内 → 200 + accessExpired: false", async () => {
      await setEnrollment(FUTURE, FUTURE);
      const res = await studentRequest.get(`/quizzes/by-lesson/${lessonId}`);
      expect(res.status).toBe(200);
      expect(res.body.accessExpired).toBeFalsy();
    });

    it("期限切れ → 200 + accessExpired: true + expiredReason", async () => {
      await setEnrollment(PAST, FUTURE);
      const res = await studentRequest.get(`/quizzes/by-lesson/${lessonId}`);
      expect(res.status).toBe(200);
      expect(res.body.accessExpired).toBe(true);
      expect(res.body.expiredReason).toBe("quiz_access_expired");
    });
  });

  describe("POST /quizzes/:quizId/attempts", () => {
    it("期限内 → 201 attempt 作成", async () => {
      await setEnrollment(FUTURE, FUTURE);
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      expect(res.status).toBe(201);
      expect(res.body.attempt).toBeDefined();
    });

    it("期限切れ → 403 quiz_access_expired", async () => {
      await setEnrollment(PAST, FUTURE);
      const res = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("quiz_access_expired");
    });
  });

  describe("PATCH /quiz-attempts/:attemptId", () => {
    it("期限切れ → 403 quiz_access_expired（提出時の期限跨ぎ）", async () => {
      // 1. 期限内で attempt 作成
      await setEnrollment(FUTURE, FUTURE);
      const createRes = await studentRequest.post(`/quizzes/${quizId}/attempts`);
      expect(createRes.status).toBe(201);
      const attemptId = createRes.body.attempt.id;

      // 2. 期限を切れた状態に変更
      await setEnrollment(PAST, FUTURE);

      // 3. 提出 → 403
      const submitRes = await studentRequest
        .patch(`/quiz-attempts/${attemptId}`)
        .send({ answers: [{ questionId: "q1", selectedOptionIds: ["q1-b"] }] });
      expect(submitRes.status).toBe(403);
      expect(submitRes.body.error).toBe("quiz_access_expired");
    });
  });

  // ─── Video エンドポイント ───

  describe("GET /videos/:videoId/playback-url", () => {
    it("enrollment 未登録 → 200 OK", async () => {
      const res = await studentRequest.get(`/videos/${videoId}/playback-url`);
      expect(res.status).toBe(200);
    });

    it("期限切れ → 403 video_access_expired", async () => {
      await setEnrollment(FUTURE, PAST);
      const res = await studentRequest.get(`/videos/${videoId}/playback-url`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("video_access_expired");
    });
  });

  describe("POST /videos/:videoId/events", () => {
    it("期限切れ → 403 video_access_expired", async () => {
      await setEnrollment(FUTURE, PAST);
      const res = await studentRequest
        .post(`/videos/${videoId}/events`)
        .send({
          sessionToken: "test-session",
          events: [
            {
              eventType: "heartbeat",
              position: 10,
              playbackRate: 1,
              clientTimestamp: NOW.getTime(),
            },
          ],
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("video_access_expired");
    });
  });

  // ─── 境界値テスト ───

  describe("期限境界値", () => {
    const DEADLINE = "2026-04-02T10:30:00Z";

    it("deadline の 1 秒前 → 200 OK", async () => {
      vi.setSystemTime(new Date("2026-04-02T10:29:59Z"));
      await setEnrollment(DEADLINE, FUTURE);
      const res = await studentRequest.get(`/quizzes/${quizId}`);
      expect(res.status).toBe(200);
    });

    it("deadline ちょうど → 403（now >= deadline で拒否）", async () => {
      vi.setSystemTime(new Date(DEADLINE));
      await setEnrollment(DEADLINE, FUTURE);
      const res = await studentRequest.get(`/quizzes/${quizId}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("quiz_access_expired");
    });

    it("deadline の 1 秒後 → 403", async () => {
      vi.setSystemTime(new Date("2026-04-02T10:30:01Z"));
      await setEnrollment(DEADLINE, FUTURE);
      const res = await studentRequest.get(`/quizzes/${quizId}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("quiz_access_expired");
    });
  });
});
