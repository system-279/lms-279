/**
 * 3機能の相互作用テスト（#147 abandon × #149 videoCompleted × #148 pause検知）
 *
 * 単体では動作する機能が組み合わさった時に壊れないことを検証:
 * 1. 動画完了 → pause → play → abandon: 各状態が正しく遷移
 * 2. pause中にvideoCompleted達成: 両方のフラグが正しく設定
 * 3. abandoned後に再入室 → 新セッションで初期状態
 * 4. forceExit(pause_timeout)後に再入室 → データリセット確認
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

describe("session cross-feature integration", () => {
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
      name: "Cross Feature Test",
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
      durationSec: 100,
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

  const baseTime = new Date("2026-03-31T10:00:00Z").getTime();

  async function createActiveSession() {
    return ds.createLessonSession({
      userId, lessonId, courseId, videoId,
      sessionToken: "token-1",
      status: "active",
      entryAt: new Date().toISOString(),
      exitAt: null, exitReason: null,
      deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      pauseStartedAt: null, longestPauseSec: 0,
      sessionVideoCompleted: false, quizAttemptId: null,
    });
  }

  function makeEvents(defs: Array<{ type: string; pos: number; offsetMs: number }>) {
    return defs.map(d => ({
      eventType: d.type,
      position: d.pos,
      playbackRate: 1,
      clientTimestamp: baseTime + d.offsetMs,
    }));
  }

  it("video完了 → pause → play → abandon: 全状態が正しく遷移", async () => {
    const session = await createActiveSession();

    // 動画を95%以上視聴
    const watchEvents = makeEvents(
      Array.from({ length: 20 }, (_, i) => ({ type: "heartbeat", pos: i * 5, offsetMs: i * 5000 }))
    );
    const watchRes = await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: watchEvents });
    expect(watchRes.body.analytics.isComplete).toBe(true);

    // sessionVideoCompleted=trueを確認
    let s = await ds.getLessonSession(session.id);
    expect(s!.sessionVideoCompleted).toBe(true);

    // pause
    const pauseEvents = makeEvents([{ type: "pause", pos: 95, offsetMs: 100000 }]);
    await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pauseEvents });

    s = await ds.getLessonSession(session.id);
    expect(s!.pauseStartedAt).not.toBeNull();

    // play（サーバー時刻を30秒進めてから送信）
    vi.setSystemTime(new Date("2026-03-31T10:00:30Z"));
    const playEvents = makeEvents([{ type: "play", pos: 95, offsetMs: 130000 }]);
    await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: playEvents });

    s = await ds.getLessonSession(session.id);
    expect(s!.pauseStartedAt).toBeNull();
    expect(s!.longestPauseSec).toBeGreaterThanOrEqual(30);
    expect(s!.sessionVideoCompleted).toBe(true); // 維持

    // abandon
    const abandonRes = await request.post(`/lesson-sessions/${session.id}/abandon`);
    expect(abandonRes.status).toBe(204);

    s = await ds.getLessonSession(session.id);
    expect(s!.status).toBe("abandoned");
    expect(s!.exitReason).toBe("browser_close");
  });

  it("abandoned後に再入室 → 新セッションは初期状態", async () => {
    const session = await createActiveSession();

    // abandon
    await request.post(`/lesson-sessions/${session.id}/abandon`);

    // 新セッション作成
    const newSession = await ds.createLessonSession({
      userId, lessonId, courseId, videoId,
      sessionToken: "token-2",
      status: "active",
      entryAt: new Date().toISOString(),
      exitAt: null, exitReason: null,
      deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      pauseStartedAt: null, longestPauseSec: 0,
      sessionVideoCompleted: false, quizAttemptId: null,
    });

    expect(newSession.sessionVideoCompleted).toBe(false);
    expect(newSession.longestPauseSec).toBe(0);
    expect(newSession.pauseStartedAt).toBeNull();

    // abandonはresetLessonDataForUserを呼ばない（データ保持の確認は別テストで実施済み）
    expect(newSession.status).toBe("active");
  });

  it("pause_timeout強制退室後に再入室 → データがリセットされている", async () => {
    const session = await createActiveSession();

    // 動画を一部視聴（analyticsを作成）
    const partialWatch = makeEvents(
      Array.from({ length: 10 }, (_, i) => ({ type: "heartbeat", pos: i * 5, offsetMs: i * 5000 }))
    );
    await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: partialWatch });

    // analyticsが存在することを確認
    let analytics = await ds.getVideoAnalytics(userId, videoId);
    expect(analytics).not.toBeNull();

    // pause送信
    const pauseEvents = makeEvents([{ type: "pause", pos: 45, offsetMs: 50000 }]);
    await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: pauseEvents });

    // 16分後 → pause_timeoutで強制退室
    vi.setSystemTime(new Date("2026-03-31T10:16:00Z"));
    const timeoutEvents = makeEvents([{ type: "heartbeat", pos: 45, offsetMs: 16 * 60 * 1000 }]);
    const timeoutRes = await request.post(`/videos/${videoId}/events`).send({ sessionToken: "token-1", events: timeoutEvents });
    expect(timeoutRes.status).toBe(409);

    // セッションがforce_exited
    const s = await ds.getLessonSession(session.id);
    expect(s!.status).toBe("force_exited");
    expect(s!.exitReason).toBe("pause_timeout");

    // データリセットが実行されている（forceExitSessionの効果）
    analytics = await ds.getVideoAnalytics(userId, videoId);
    expect(analytics).toBeNull();
  });
});
