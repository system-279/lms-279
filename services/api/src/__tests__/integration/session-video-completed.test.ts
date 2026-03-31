/**
 * sessionVideoCompleted 更新ロジックのテスト
 *
 * video-eventsルートでcoverageRatio >= requiredWatchRatio達成時に
 * セッション内のsessionVideoCompletedフラグをtrueに更新する。
 */

import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

describe("sessionVideoCompleted via video-events", () => {
  let request: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let videoId: string;
  let lessonId: string;
  let courseId: string;
  const userId = "test-student-1";

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
      durationSec: 100, // 100秒の動画
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    videoId = video.id;

    const app = express();
    app.use(cors());
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantContext = { tenantId: "test-tenant", isDemo: false };
      req.dataSource = ds;
      req.user = { id: userId, email: "student@test.com", role: "student" };
      next();
    });
    app.use(createSharedRouter());

    request = supertest(app);
  });

  async function createActiveSession() {
    return ds.createLessonSession({
      userId,
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
  }

  function makeHeartbeatEvents(positions: number[]) {
    const now = Date.now();
    return positions.map((pos, i) => ({
      eventType: "heartbeat",
      position: pos,
      playbackRate: 1,
      clientTimestamp: now + i * 5000,
    }));
  }

  it("sets sessionVideoCompleted=true when coverage reaches requiredWatchRatio", async () => {
    const session = await createActiveSession();

    // 0〜96秒をカバーするイベントを送信（96/100 = 0.96 >= 0.95）
    const events = makeHeartbeatEvents([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);

    const res = await request
      .post(`/videos/${videoId}/events`)
      .send({ sessionToken: "token-1", events });

    expect(res.status).toBe(200);
    expect(res.body.analytics.isComplete).toBe(true);

    // セッションのsessionVideoCompletedが更新されていること
    const updated = await ds.getLessonSession(session.id);
    expect(updated!.sessionVideoCompleted).toBe(true);
  });

  it("does not update sessionVideoCompleted when coverage is below threshold", async () => {
    const session = await createActiveSession();

    // 0〜45秒のみカバー（0.50 < 0.95）
    const events = makeHeartbeatEvents([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);

    const res = await request
      .post(`/videos/${videoId}/events`)
      .send({ sessionToken: "token-1", events });

    expect(res.status).toBe(200);
    expect(res.body.analytics.isComplete).toBe(false);

    const updated = await ds.getLessonSession(session.id);
    expect(updated!.sessionVideoCompleted).toBe(false);
  });

  it("does not re-update if sessionVideoCompleted is already true (idempotent)", async () => {
    const session = await createActiveSession();
    // 手動でtrueに設定
    await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

    const events = makeHeartbeatEvents([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);

    const res = await request
      .post(`/videos/${videoId}/events`)
      .send({ sessionToken: "token-1", events });

    expect(res.status).toBe(200);

    // 依然trueのまま（エラーなく処理される）
    const updated = await ds.getLessonSession(session.id);
    expect(updated!.sessionVideoCompleted).toBe(true);
  });

  it("does not error when no active session exists", async () => {
    // セッション未作成でもイベント送信は正常に処理される
    const events = makeHeartbeatEvents([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);

    const res = await request
      .post(`/videos/${videoId}/events`)
      .send({ sessionToken: "token-1", events });

    expect(res.status).toBe(200);
    expect(res.body.analytics.isComplete).toBe(true);
  });
});
