/**
 * サーバーサイド一時停止検知のテスト
 *
 * video-eventsルートでpause/playイベントを受信し:
 * - pauseStartedAt / longestPauseSec を更新
 * - 15分超過で forceExitSession を発動し 409 を返す
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

describe("server-side pause detection via video-events", () => {
  let request: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let videoId: string;
  let lessonId: string;
  let courseId: string;
  const userId = "test-student-1";

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T10:00:00Z"));

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

  afterEach(() => {
    vi.useRealTimers();
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

  const baseTime = new Date("2026-03-31T10:00:00Z").getTime();

  function makeEvents(eventDefs: Array<{ type: string; position: number; offsetMs: number }>) {
    return eventDefs.map((def) => ({
      eventType: def.type,
      position: def.position,
      playbackRate: 1,
      clientTimestamp: baseTime + def.offsetMs,
    }));
  }

  describe("pause/play state tracking", () => {
    it("records pauseStartedAt when pause event is received", async () => {
      const session = await createActiveSession();

      const events = makeEvents([
        { type: "play", position: 0, offsetMs: 0 },
        { type: "heartbeat", position: 5, offsetMs: 5000 },
        { type: "pause", position: 10, offsetMs: 10000 },
      ]);

      const res = await request
        .post(`/videos/${videoId}/events`)
        .send({ sessionToken: "token-1", events });

      expect(res.status).toBe(200);

      const updated = await ds.getLessonSession(session.id);
      expect(updated!.pauseStartedAt).not.toBeNull();
    });

    it("clears pauseStartedAt and updates longestPauseSec when play event follows pause", async () => {
      const session = await createActiveSession();

      // まずpauseを送信
      const pauseEvents = makeEvents([
        { type: "pause", position: 10, offsetMs: 10000 },
      ]);
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pauseEvents });

      // 30秒後にplayを送信
      const playEvents = makeEvents([
        { type: "play", position: 10, offsetMs: 40000 }, // 30秒後
      ]);
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: playEvents });

      const updated = await ds.getLessonSession(session.id);
      expect(updated!.pauseStartedAt).toBeNull();
      expect(updated!.longestPauseSec).toBeGreaterThanOrEqual(30);
    });

    it("keeps longest pause (does not overwrite with shorter pause)", async () => {
      const session = await createActiveSession();

      // 1回目: 60秒のpause
      const pause1 = makeEvents([{ type: "pause", position: 10, offsetMs: 10000 }]);
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pause1 });

      const play1 = makeEvents([{ type: "play", position: 10, offsetMs: 70000 }]); // 60秒後
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: play1 });

      // 2回目: 10秒のpause
      const pause2 = makeEvents([{ type: "pause", position: 20, offsetMs: 80000 }]);
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pause2 });

      const play2 = makeEvents([{ type: "play", position: 20, offsetMs: 90000 }]); // 10秒後
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: play2 });

      const updated = await ds.getLessonSession(session.id);
      expect(updated!.longestPauseSec).toBeGreaterThanOrEqual(60); // 60秒が保持される
    });

    it("does nothing when no active session exists", async () => {
      // セッションなしでもpause/playイベントはエラーにならない
      const events = makeEvents([
        { type: "pause", position: 10, offsetMs: 10000 },
      ]);

      const res = await request
        .post(`/videos/${videoId}/events`)
        .send({ sessionToken: "token-1", events });

      expect(res.status).toBe(200);
    });
  });

  describe("15-minute pause timeout", () => {
    it("force-exits session when pause exceeds 15 minutes", async () => {
      const session = await createActiveSession();

      // pauseを送信
      const pauseEvents = makeEvents([
        { type: "pause", position: 10, offsetMs: 0 },
      ]);
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pauseEvents });

      // 16分後にheartbeatを送信（サーバーが15分超過を検知）
      vi.setSystemTime(new Date("2026-03-31T10:16:00Z"));

      const heartbeatEvents = makeEvents([
        { type: "heartbeat", position: 10, offsetMs: 16 * 60 * 1000 },
      ]);
      const res = await request
        .post(`/videos/${videoId}/events`)
        .send({ sessionToken: "token-1", events: heartbeatEvents });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_force_exited");

      // セッションがforce_exitedになっていること
      const updated = await ds.getLessonSession(session.id);
      expect(updated!.status).toBe("force_exited");
      expect(updated!.exitReason).toBe("pause_timeout");
    });

    it("does not force-exit when pause is under 15 minutes", async () => {
      const session = await createActiveSession();

      // pauseを送信
      const pauseEvents = makeEvents([
        { type: "pause", position: 10, offsetMs: 0 },
      ]);
      await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pauseEvents });

      // 14分後にheartbeat（15分未満なのでOK）
      vi.setSystemTime(new Date("2026-03-31T10:14:00Z"));

      const heartbeatEvents = makeEvents([
        { type: "heartbeat", position: 10, offsetMs: 14 * 60 * 1000 },
      ]);
      const res = await request
        .post(`/videos/${videoId}/events`)
        .send({ sessionToken: "token-1", events: heartbeatEvents });

      expect(res.status).toBe(200);

      const updated = await ds.getLessonSession(session.id);
      expect(updated!.status).toBe("active");
    });
  });
});
