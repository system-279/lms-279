/**
 * テスト任意化 Stage 3: テストスキップ API の統合テスト
 *
 * 計画: ~/.claude/plans/floating-strolling-spindle.md（plan mode 承認済み、Codex plan review 反映）
 *
 * ゲート順序: quiz存在(404) → 既にスキップ済みなら200冪等（他ゲートより前） →
 *   ポリシーOFF(403) → 動画未完了(403) → 受講期限切れ(403) →
 *   合格済み(409) → in_progress attempt(409) → 本処理
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import supertest from "supertest";
import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";
import { logger } from "../../utils/logger.js";

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

describe("テスト任意化 Stage 3: POST /quizzes/:quizId/skip", () => {
  let studentRequest: ReturnType<typeof supertest>;
  let ds: InMemoryDataSource;
  let quizId: string;
  let lessonId: string;
  let courseId: string;
  let videoId: string;
  const studentUserId = "test-student-skip";

  async function enableSkipPolicy() {
    await ds.upsertTenantQuizPolicy({
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
    });
  }

  /**
   * video_analytics.isComplete（動画完了ゲートの判定元）と
   * user_progress.videoCompleted（lessonCompleted 算出の判定元）は別フィールド。
   * 実アプリでは POST /events (video-events.ts) が isComplete=true 化と同時に
   * updateLessonProgress({videoCompleted:true}) を呼ぶため、テストでも両方を再現する。
   */
  async function completeVideo(targetLessonId = lessonId, targetVideoId = videoId, targetCourseId = courseId) {
    await ds.upsertVideoAnalytics(studentUserId, targetVideoId, {
      isComplete: true,
      coverageRatio: 0.98,
      totalWatchTimeSec: 290,
      watchedRanges: [{ start: 0, end: 290 }],
    });
    await ds.upsertUserProgress(studentUserId, targetLessonId, {
      courseId: targetCourseId,
      videoCompleted: true,
    });
  }

  beforeEach(async () => {
    ds = new InMemoryDataSource({ readOnly: false });

    const course = await ds.createCourse({
      name: "スキップテストコース",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    courseId = course.id;

    const lesson = await ds.createLesson({
      courseId,
      title: "スキップテストレッスン",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    lessonId = lesson.id;

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

    const quiz = await ds.createQuiz({
      lessonId,
      courseId,
      title: "スキップテスト",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false, // 動画完了ゲートはskip側で無条件適用するため、既存ゲートはあえてOFFにして区別する
      questions: testQuestions,
    });
    quizId = quiz.id;

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

  // ============================================================
  // ゲート: ポリシー OFF
  // ============================================================
  it("ポリシーOFF(未設定)のテナントでは403 quiz_skip_disabled", async () => {
    await completeVideo();
    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("quiz_skip_disabled");
  });

  // ============================================================
  // ゲート: 動画未完了（requireVideoCompletion=false でも無条件適用される）
  // ============================================================
  it("動画未完了では403 video_not_completed（quiz.requireVideoCompletion=falseでも無条件ゲート）", async () => {
    await enableSkipPolicy();
    // completeVideo() を呼ばない = 動画未完了のまま

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("video_not_completed");
  });

  // ============================================================
  // ゲート: 受講期限切れ
  // ============================================================
  it("受講期限切れでは403", async () => {
    await enableSkipPolicy();
    await completeVideo();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await ds.upsertTenantEnrollmentSetting({
      enrolledAt: past,
      quizAccessUntil: past,
      videoAccessUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      createdBy: "admin@example.com",
    });

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(403);
  });

  // ============================================================
  // happy path: activeSession なし → 合成 session 作成
  // ============================================================
  it("happy path(セッションなし): 200 + quizSkipped=true + 合成sessionが作成される", async () => {
    await enableSkipPolicy();
    await completeVideo();

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(200);
    expect(res.body.quizSkipped).toBe(true);
    expect(res.body.lessonCompleted).toBe(true);
    expect(res.body.sessionRecorded).toBe(true);

    const progress = await ds.getUserProgress(studentUserId, lessonId);
    expect(progress?.quizSkipped).toBe(true);
    expect(progress?.quizSkippedAt).not.toBeNull();
    expect(progress?.lessonCompleted).toBe(true);
    expect(progress?.quizPassed).toBe(false);

    const syntheticId = `synthetic_skip_${studentUserId}_${lessonId}`;
    const synthetic = await ds.getLessonSession(syntheticId);
    expect(synthetic).not.toBeNull();
    expect(synthetic!.status).toBe("completed");
    expect(synthetic!.exitReason).toBe("quiz_skipped");
    expect(synthetic!.isSynthetic).toBe(true);
    expect(synthetic!.quizAttemptId).toBeNull();
  });

  // ============================================================
  // happy path: activeSession あり → completeSessionAsQuizSkipped
  // ============================================================
  it("happy path(セッションあり): 200 + アクティブセッションがexitReason=quiz_skippedで完了する", async () => {
    await enableSkipPolicy();
    await completeVideo();

    const sessionRes = await studentRequest.post("/lesson-sessions").send({
      lessonId,
      videoId,
      sessionToken: "skip-session-token",
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.body.session.id;

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(200);
    expect(res.body.sessionRecorded).toBe(true);

    const session = await ds.getLessonSession(sessionId);
    expect(session?.status).toBe("completed");
    expect(session?.exitReason).toBe("quiz_skipped");
    expect(session?.quizAttemptId).toBeNull();

    // 合成 session は作られない(既存セッションを完了させたのみ)
    const synthetic = await ds.getLessonSession(`synthetic_skip_${studentUserId}_${lessonId}`);
    expect(synthetic).toBeNull();
  });

  // ============================================================
  // 冪等性: 2回叩いても重複行が発生しない
  // ============================================================
  it("同一APIを2回叩いてもlesson_sessionsが1行のままで、2回目も200", async () => {
    await enableSkipPolicy();
    await completeVideo();

    const res1 = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res1.status).toBe(200);

    const res2 = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res2.status).toBe(200);
    expect(res2.body.quizSkipped).toBe(true);

    const sessions = (await ds.getLessonSessionsByCourse(courseId)).filter(
      (s) => s.id === `synthetic_skip_${studentUserId}_${lessonId}`
    );
    expect(sessions.length).toBe(1);
  });

  // ============================================================
  // 冪等性: ポリシーが後からOFFに変わっても、既にスキップ済みなら2回目も200
  // (Codex plan review Critical指摘: 冪等判定を他ゲートより前に置く設計の固定)
  // ============================================================
  it("スキップ成功後にポリシーをOFFに戻して再度叩いても200のまま", async () => {
    await enableSkipPolicy();
    await completeVideo();

    const res1 = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res1.status).toBe(200);

    // ポリシーをOFFに戻す
    await ds.upsertTenantQuizPolicy({
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: false,
      updatedBy: "admin@example.com",
    });

    const res2 = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res2.status).toBe(200);
    expect(res2.body.quizSkipped).toBe(true);
  });

  // ============================================================
  // 409: 合格済み
  // ============================================================
  it("既に合格済みなら409 quiz_already_passed", async () => {
    await enableSkipPolicy();
    await completeVideo();

    const attemptRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
    const attemptId = attemptRes.body.attempt.id;
    await studentRequest.patch(`/quiz-attempts/${attemptId}`).send({ answers: { q1: ["q1-a"] } });

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("quiz_already_passed");
  });

  // ============================================================
  // 409: 受験中の attempt がある
  // ============================================================
  it("in_progress attemptがあれば409 attempt_in_progress", async () => {
    await enableSkipPolicy();
    await completeVideo();

    await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("attempt_in_progress");
  });

  // ============================================================
  // 動画なしレッスン: 200 + session未作成 + ログのみ
  // ============================================================
  it("動画なしレッスンでは200 + 合成session未作成 + info ログのみ(正常系)", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");

    const lessonNoVideo = await ds.createLesson({
      courseId,
      title: "動画なしレッスン",
      order: 2,
      hasVideo: false,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    const quizNoVideo = await ds.createQuiz({
      lessonId: lessonNoVideo.id,
      courseId,
      title: "動画なしテスト",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: testQuestions,
    });

    await enableSkipPolicy();

    const res = await studentRequest.post(`/quizzes/${quizNoVideo.id}/skip`).send({});
    expect(res.status).toBe(200);
    expect(res.body.sessionRecorded).toBe(false);

    const progress = await ds.getUserProgress(studentUserId, lessonNoVideo.id);
    expect(progress?.quizSkipped).toBe(true);
    // 注: hasVideo=false のレッスンは videoCompleted が既存アプリのどの経路でも true にならない
    // (video-events.ts の videoCompleted:true 付与は動画完了イベント経由のみ、Stage 3 起因ではない
    // 既存の制約)。そのため computeLessonCompleted は false のままになる。
    expect(progress?.lessonCompleted).toBe(false);

    const synthetic = await ds.getLessonSession(
      `synthetic_skip_${studentUserId}_${lessonNoVideo.id}`
    );
    expect(synthetic).toBeNull();

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining("without session"),
      expect.objectContaining({ eventType: "quiz_skip_session_video_missing" })
    );

    loggerInfoSpy.mockRestore();
  });

  // ============================================================
  // Codex High反映: スキップ後もそのままテスト受験できる(設計判断9の固定)
  // ============================================================
  it("スキップ後もテスト受験できる: quizPassed=trueとquizSkipped=trueが併存し、進捗応答は両方trueを返す", async () => {
    await enableSkipPolicy();
    await completeVideo();

    const skipRes = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(skipRes.status).toBe(200);

    const attemptRes = await studentRequest.post(`/quizzes/${quizId}/attempts`).send({});
    expect(attemptRes.status).toBe(201);
    const attemptId = attemptRes.body.attempt.id;

    const submitRes = await studentRequest
      .patch(`/quiz-attempts/${attemptId}`)
      .send({ answers: { q1: ["q1-a"] } });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.attempt.isPassed).toBe(true);

    const progress = await ds.getUserProgress(studentUserId, lessonId);
    expect(progress?.quizPassed).toBe(true);
    expect(progress?.quizSkipped).toBe(true);

    const progressRes = await studentRequest.get(
      `/courses/${courseId}/lessons/${lessonId}/progress`
    );
    expect(progressRes.status).toBe(200);
    expect(progressRes.body.progress.quizPassed).toBe(true);
    expect(progressRes.body.progress.quizSkipped).toBe(true);
  });

  // ============================================================
  // Codex High反映: セッション処理中のレース(並行force-exit)への耐性(設計判断4改訂の固定)
  //
  // HTTP経由では「getActiveLessonSessionを呼んだ直後、completeSessionAsQuizSkippedを
  // 呼ぶ直前」というリクエスト内の狭いwindowを外部から割り込ませられないため、
  // completeSessionAsQuizSkipped をサービス層で直接呼び、既に非activeなセッションに
  // 対して呼ばれても quiet pass (null を返し上書きしない) することを検証する。
  // ============================================================
  it("completeSessionAsQuizSkippedは非activeなセッションに対してnullを返し上書きしない", async () => {
    const { completeSessionAsQuizSkipped } = await import("../../services/lesson-session.js");

    const sessionRes = await studentRequest.post("/lesson-sessions").send({
      lessonId,
      videoId,
      sessionToken: "race-session-token",
    });
    const sessionId = sessionRes.body.session.id;

    // 並行して force-exit が先に完了したケースを模倣
    await ds.updateLessonSession(sessionId, {
      status: "force_exited",
      exitAt: new Date().toISOString(),
      exitReason: "time_limit",
    });

    const result = await completeSessionAsQuizSkipped(ds, sessionId);
    expect(result).toBeNull();

    // force_exited のまま上書きされていない
    const session = await ds.getLessonSession(sessionId);
    expect(session?.status).toBe("force_exited");
    expect(session?.exitReason).toBe("time_limit");
  });

  // ============================================================
  // videoDurationSec 不正 → 200 維持 + logger.error
  // ============================================================
  it("video.durationSecが不正(0)でも200維持 + logger.errorで観測可能", async () => {
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    const lessonBadVideo = await ds.createLesson({
      courseId,
      title: "不正動画レッスン",
      order: 3,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    const badVideo = await ds.createVideo({
      lessonId: lessonBadVideo.id,
      courseId,
      sourceType: "external_url",
      sourceUrl: "https://example.com/bad.mp4",
      durationSec: 0,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    const quizBadVideo = await ds.createQuiz({
      lessonId: lessonBadVideo.id,
      courseId,
      title: "不正動画テスト",
      passThreshold: 70,
      maxAttempts: 5,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: testQuestions,
    });
    await ds.upsertVideoAnalytics(studentUserId, badVideo.id, {
      isComplete: true,
      coverageRatio: 0.98,
      totalWatchTimeSec: 290,
      watchedRanges: [{ start: 0, end: 290 }],
    });
    await enableSkipPolicy();

    const res = await studentRequest.post(`/quizzes/${quizBadVideo.id}/skip`).send({});
    expect(res.status).toBe(200);
    expect(res.body.sessionRecorded).toBe(false);

    const progress = await ds.getUserProgress(studentUserId, lessonBadVideo.id);
    expect(progress?.quizSkipped).toBe(true);

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to record skip session"),
      expect.objectContaining({ eventType: "quiz_skip_session_failed" })
    );

    loggerErrorSpy.mockRestore();
  });

  // ============================================================
  // GET /quizzes/by-lesson/:lessonId の skipAvailable/quizSkipped 応答
  // ============================================================
  it("GET by-lesson: ポリシーOFFではskipAvailable=false", async () => {
    await completeVideo();
    const res = await studentRequest.get(`/quizzes/by-lesson/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.skipAvailable).toBe(false);
    expect(res.body.quizSkipped).toBe(false);
  });

  it("GET by-lesson: ポリシーON+動画完了+未合格+受験中なしならskipAvailable=true", async () => {
    await enableSkipPolicy();
    await completeVideo();
    const res = await studentRequest.get(`/quizzes/by-lesson/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.skipAvailable).toBe(true);
    expect(res.body.pdfDownloadAllowedForSkipped).toBe(true);
  });

  it("GET by-lesson: 動画未完了ならポリシーONでもskipAvailable=false", async () => {
    await enableSkipPolicy();
    const res = await studentRequest.get(`/quizzes/by-lesson/${lessonId}`);
    expect(res.status).toBe(200);
    expect(res.body.skipAvailable).toBe(false);
  });

  // ============================================================
  // completion-eligibility結合: スキップ経由完了の実データ経路確認(Codex High反映)
  // ============================================================
  it("スキップ経由でのみ完了したコースはcourse_progress.isCompletedがtrueになる", async () => {
    // updateCourseProgress は course.lessonOrder が空だと totalLessons=0 で早期returnするため、
    // このテストでは明示的に lessonOrder を設定する(他テストは skip API 応答のみを見るため不要)
    await ds.updateCourse(courseId, { lessonOrder: [lessonId] });

    await enableSkipPolicy();
    await completeVideo();

    const res = await studentRequest.post(`/quizzes/${quizId}/skip`).send({});
    expect(res.status).toBe(200);

    // updateCourseProgress は updateLessonProgress 内部から自動的に呼ばれる
    const courseProgress = await ds.getCourseProgress(studentUserId, courseId);
    expect(courseProgress?.isCompleted).toBe(true);
    expect(courseProgress?.completedLessons).toBe(1);
    expect(courseProgress?.totalLessons).toBe(1);
  });
});
