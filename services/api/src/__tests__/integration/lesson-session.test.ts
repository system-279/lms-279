import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import {
  createSession,
  getOrCreateSession,
  forceExitSession,
  abandonSession,
  completeSession,
  validateSessionDeadline,
  handleStaleSession,
} from "../../services/lesson-session.js";

describe("lesson-session service", () => {
  let ds: InMemoryDataSource;

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  // テスト用にレッスンとビデオを作成するヘルパー
  async function setupLesson() {
    const course = await ds.createCourse({
      name: "Test Course",
      description: null,
      status: "published",
      lessonOrder: [],
      passThreshold: 80,
      createdBy: "admin",
    });
    const lesson = await ds.createLesson({
      courseId: course.id,
      title: "Test Lesson",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
    });
    const video = await ds.createVideo({
      lessonId: lesson.id,
      courseId: course.id,
      sourceType: "gcs",
      gcsPath: "test/video.mp4",
      durationSec: 300,
      requiredWatchRatio: 0.95,
      speedLock: true,
    });
    return { course, lesson, video };
  }

  // レッスン + quiz + in_progress attempt を作成するヘルパー
  async function setupLessonWithInProgressAttempt(userId: string) {
    const setup = await setupLesson();
    const quiz = await ds.createQuiz({
      lessonId: setup.lesson.id,
      courseId: setup.course.id,
      title: "Test Quiz",
      passThreshold: 70,
      maxAttempts: 3,
      timeLimitSec: null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: false,
      questions: [
        {
          id: "q1",
          text: "Q1",
          type: "single",
          options: [
            { id: "a", text: "A", isCorrect: true },
            { id: "b", text: "B", isCorrect: false },
          ],
          points: 100,
          explanation: "",
        },
      ],
    });
    const attempt = await ds.createQuizAttempt({
      quizId: quiz.id,
      userId,
      attemptNumber: 1,
      status: "in_progress",
      answers: { q1: ["a"] },
      score: null,
      isPassed: null,
      startedAt: new Date().toISOString(),
      submittedAt: null,
    });
    return { ...setup, quiz, attempt };
  }

  describe("createSession", () => {
    it("creates an active session with correct fields", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      expect(session.status).toBe("active");
      expect(session.userId).toBe("user1");
      expect(session.lessonId).toBe(lesson.id);
      expect(session.videoId).toBe(video.id);
      expect(session.sessionToken).toBe("token-1");
      expect(session.exitAt).toBeNull();
      expect(session.exitReason).toBeNull();
      expect(session.sessionVideoCompleted).toBe(false);
      expect(session.longestPauseSec).toBe(0);
    });

    it("sets deadlineAt to entryAt + SESSION_DURATION_MS", async () => {
      const { SESSION_DURATION_MS } = await import("../../services/lesson-session.js");
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      const entry = new Date(session.entryAt).getTime();
      const deadline = new Date(session.deadlineAt).getTime();
      expect(deadline - entry).toBe(SESSION_DURATION_MS);
    });
  });

  describe("getOrCreateSession", () => {
    it("returns existing active session if one exists", async () => {
      const { lesson, video } = await setupLesson();
      const created = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const result = await getOrCreateSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-2");

      expect(result.session.id).toBe(created.id);
      expect(result.created).toBe(false);
    });

    it("creates new session if none exists", async () => {
      const { lesson, video } = await setupLesson();
      const result = await getOrCreateSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      expect(result.session.status).toBe("active");
      expect(result.created).toBe(true);
    });
  });

  describe("forceExitSession", () => {
    it("sets status to force_exited with reason", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const exited = await forceExitSession(ds, session.id, "pause_timeout");

      expect(exited.status).toBe("force_exited");
      expect(exited.exitReason).toBe("pause_timeout");
      expect(exited.exitAt).toBeTruthy();
    });

    it("works with time_limit reason", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const exited = await forceExitSession(ds, session.id, "time_limit");

      expect(exited.exitReason).toBe("time_limit");
    });

    // Issue #422: forceExitSession 後に in_progress attempt が残ると次回テスト開始不能になる
    it("cleans up in_progress quiz attempts to timed_out (sessionVideoCompleted=true path)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 動画完了済みフラグを立てて、resetLessonDataForUser がスキップされる経路をシミュレート
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      await forceExitSession(ds, session.id, "time_limit");

      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).not.toBeNull();
      expect(cleaned!.status).toBe("timed_out");
      expect(cleaned!.submittedAt).toBeTruthy();
    });

    it("preserves answers when cleaning up in_progress attempts (audit trail)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      await forceExitSession(ds, session.id, "time_limit");

      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned!.answers).toEqual({ q1: ["a"] }); // 既存値が保持される
      expect(cleaned!.score).toBeNull();
      expect(cleaned!.isPassed).toBeNull();
      expect(cleaned!.attemptNumber).toBe(1);
    });

    it("allows creating a new attempt after force-exit (regression for stuck-in-progress bug)", async () => {
      const { lesson, video, quiz } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      await forceExitSession(ds, session.id, "time_limit");

      // 次の attempt 作成が成功すること（in_progress 一意性制約を超えられる）
      const result = await ds.createQuizAttemptAtomic(
        quiz.id,
        "user1",
        quiz.maxAttempts,
        quiz.timeLimitSec,
        {
          quizId: quiz.id,
          userId: "user1",
          status: "in_progress",
          answers: {},
          score: null,
          isPassed: null,
          startedAt: new Date().toISOString(),
          submittedAt: null,
        }
      );
      expect(result).not.toBeNull();
      expect(result!.existing).toBe(false);
      expect(result!.attempt.attemptNumber).toBe(2);
    });

    it("does not affect other users' in_progress attempts", async () => {
      const { lesson, video, quiz } = await setupLessonWithInProgressAttempt("user1");
      // 別ユーザーの in_progress attempt
      const otherAttempt = await ds.createQuizAttempt({
        quizId: quiz.id,
        userId: "user2",
        attemptNumber: 1,
        status: "in_progress",
        answers: {},
        score: null,
        isPassed: null,
        startedAt: new Date().toISOString(),
        submittedAt: null,
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      await forceExitSession(ds, session.id, "time_limit");

      const other = await ds.getQuizAttemptById(otherAttempt.id);
      expect(other!.status).toBe("in_progress"); // 他ユーザーには影響しない
    });

    // Issue #422: 動画完了済みデータ（video_analytics）が保護されることの回帰検証
    it("preserves video_analytics when sessionVideoCompleted=true (data protection)", async () => {
      const { lesson, video } = await setupLessonWithInProgressAttempt("user1");
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.98,
        isComplete: true,
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      await forceExitSession(ds, session.id, "time_limit");

      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).not.toBeNull();
      expect(analytics!.coverageRatio).toBe(0.98); // 動画データは保護される
      expect(analytics!.isComplete).toBe(true);
    });

    // Issue #422: maxAttempts 除外の不変条件（救済による受験回数消費なし）
    it("timed_out from cleanup is excluded from maxAttempts (recovery does not consume attempts)", async () => {
      const setup = await setupLesson();
      const quiz = await ds.createQuiz({
        lessonId: setup.lesson.id,
        courseId: setup.course.id,
        title: "Test Quiz maxAttempts=2",
        passThreshold: 70,
        maxAttempts: 2,
        timeLimitSec: null,
        randomizeQuestions: false,
        randomizeAnswers: false,
        requireVideoCompletion: false,
        questions: [
          {
            id: "q1",
            text: "Q1",
            type: "single",
            options: [
              { id: "a", text: "A", isCorrect: true },
              { id: "b", text: "B", isCorrect: false },
            ],
            points: 100,
            explanation: "",
          },
        ],
      });
      await ds.createQuizAttempt({
        quizId: quiz.id,
        userId: "user1",
        attemptNumber: 1,
        status: "in_progress",
        answers: {},
        score: null,
        isPassed: null,
        startedAt: new Date().toISOString(),
        submittedAt: null,
      });
      const session = await createSession(ds, "user1", setup.lesson.id, setup.course.id, setup.video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      await forceExitSession(ds, session.id, "time_limit");

      // 2回目作成（救済で消費されていないなら成功）
      const second = await ds.createQuizAttemptAtomic(
        quiz.id, "user1", quiz.maxAttempts, quiz.timeLimitSec,
        {
          quizId: quiz.id,
          userId: "user1",
          status: "in_progress",
          answers: {},
          score: null,
          isPassed: null,
          startedAt: new Date().toISOString(),
          submittedAt: null,
        }
      );
      expect(second).not.toBeNull();
      expect(second!.attempt.attemptNumber).toBe(2);
    });

    // TOCTOU 対策: 並行 PATCH 提出で submitted になった attempt を上書きしない
    it("does not overwrite submitted attempts (TOCTOU safety via conditional update)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      // PATCH 提出が cleanup より先に完了したシナリオ
      await ds.updateQuizAttempt(attempt.id, {
        status: "submitted",
        score: 100,
        isPassed: true,
        submittedAt: new Date().toISOString(),
      });

      await forceExitSession(ds, session.id, "time_limit");

      const after = await ds.getQuizAttemptById(attempt.id);
      expect(after!.status).toBe("submitted"); // timed_out で上書きされない
      expect(after!.score).toBe(100);
      expect(after!.isPassed).toBe(true);
    });

    // エラーパス: cleanup 内の例外は session 終了を止めない
    it("completes session even when getQuizByLessonId throws", async () => {
      const { lesson, video } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await ds.updateLessonSession(session.id, { sessionVideoCompleted: true });

      const original = ds.getQuizByLessonId.bind(ds);
      ds.getQuizByLessonId = async () => { throw new Error("simulated firestore error"); };
      try {
        const result = await forceExitSession(ds, session.id, "time_limit");
        expect(result.status).toBe("force_exited"); // session 終了は完了する
      } finally {
        ds.getQuizByLessonId = original;
      }
    });

    // ============================================================
    // ADR-027 改訂履歴 2026-05-21: 永続完了フラグ尊重（ケース E' 新設）
    //   過去にレッスンを完了済み (video_analytics.isComplete=true) のユーザーが
    //   新セッションで動画再生 → time_limit / pause_timeout に陥った場合も
    //   全リセットを skip する（新ケース E'）。max_attempts_failed は除外（ケース F semantics 維持）。
    // ============================================================

    // AC1: video_analytics.isComplete=true（永続） + sessionVideoCompleted=false + time_limit
    //      → 全リセット skip、in_progress attempt のみ cleanup（ケース E'）
    it("preserves data when persistent video_analytics.isComplete=true even if sessionVideoCompleted=false (case E')", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      // 過去の動画完了状態を永続化
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.98,
        isComplete: true,
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      // 新規セッション開始（sessionVideoCompleted=false でスタート、動画を再視聴し始めただけ）
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      expect(session.sessionVideoCompleted).toBe(false);

      // time_limit で強制退室
      await forceExitSession(ds, session.id, "time_limit");

      // video_analytics は保護される（既存完了データの温存）
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).not.toBeNull();
      expect(analytics!.isComplete).toBe(true);
      expect(analytics!.coverageRatio).toBe(0.98);

      // in_progress attempt は timed_out 化されるが削除はされない
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).not.toBeNull();
      expect(cleaned!.status).toBe("timed_out");
    });

    // AC2: video_analytics.isComplete=false + sessionVideoCompleted=false + time_limit
    //      → 既存挙動どおり全リセット（規律装置維持）
    it("still fully resets when persistent video_analytics.isComplete=false (discipline preserved)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      // 初回視聴中で未完了
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.3,
        isComplete: false,
        watchedRanges: [{ start: 0, end: 90 }],
        totalWatchTimeSec: 90,
        seekCount: 0,
        suspiciousFlags: [],
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      await forceExitSession(ds, session.id, "time_limit");

      // 全リセットされる（既存挙動）
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).toBeNull();
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).toBeNull();
    });

    // AC3: video_analytics 不在（video 削除済 or 受講初期）+ time_limit
    //      → 既存挙動どおり全リセット（null 安全フォールバック）
    it("falls back to full reset when no video_analytics exists (null-safe)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      // upsertVideoAnalytics を呼ばないので analytics は存在しない
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      await forceExitSession(ds, session.id, "time_limit");

      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).toBeNull(); // 全リセット
    });

    // AC6: max_attempts_failed は永続フラグに関わらず全リセット（ADR-027 ケース F semantics 維持）
    it("fully resets on max_attempts_failed regardless of persistent completion (case F semantics)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.98,
        isComplete: true, // 永続完了済みでも...
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 受験上限到達による強制退室は規律破りとして全リセット
      await forceExitSession(ds, session.id, "max_attempts_failed");

      // video_analytics も含めて全リセット（ケース F）
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).toBeNull();
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).toBeNull();
    });

    // AC7: セッション開始後に動画差し替え（session.videoId ≠ current video.id）
    //      → 永続フラグ無視、既存挙動にフォールバック
    it("ignores persistent completion when lesson video has been swapped after session start", async () => {
      const { lesson, video: oldVideo, attempt } = await setupLessonWithInProgressAttempt("user1");
      await ds.upsertVideoAnalytics("user1", oldVideo.id, {
        coverageRatio: 0.98,
        isComplete: true,
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      // 旧 video を使ったセッションを作成
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, oldVideo.id, "token-1");

      // レッスンの動画を差し替え（旧 video を削除、新 video を作成）
      await ds.deleteVideo(oldVideo.id);
      await ds.createVideo({
        lessonId: lesson.id,
        courseId: lesson.courseId,
        sourceType: "gcs",
        gcsPath: "test/new-video.mp4",
        durationSec: 600,
        requiredWatchRatio: 0.95,
        speedLock: true,
      });

      await forceExitSession(ds, session.id, "time_limit");

      // 動画差し替え後は旧 video の永続完了を尊重しない → 全リセット
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).toBeNull();
    });

    // AC8: pause_timeout も time_limit と同じく永続完了を尊重（対称性）
    it("preserves data on pause_timeout when persistent completion is true (symmetry with time_limit)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.98,
        isComplete: true,
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      await forceExitSession(ds, session.id, "pause_timeout");

      // pause_timeout でも永続完了済みなら保護
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).not.toBeNull();
      expect(analytics!.isComplete).toBe(true);
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned!.status).toBe("timed_out");
    });

    // AC9: getVideoByLessonId 例外時 → safe-by-default で skip reset 側にフォールバック
    //      （データ保護を優先、PR 趣旨と整合）
    it("falls back to skip reset (safe-by-default) when getVideoByLessonId throws", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.98,
        isComplete: true,
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      const original = ds.getVideoByLessonId.bind(ds);
      ds.getVideoByLessonId = async () => { throw new Error("simulated firestore error"); };
      try {
        const result = await forceExitSession(ds, session.id, "time_limit");
        // forceExitSession 自体は例外を throw せず、session は force_exited 状態になる
        expect(result.status).toBe("force_exited");
      } finally {
        ds.getVideoByLessonId = original;
      }

      // データ保護 (safe-by-default) のため video_analytics は残る
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).not.toBeNull();
      expect(analytics!.isComplete).toBe(true);
      // in_progress attempt は cleanup で timed_out 化される
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).not.toBeNull();
      expect(cleaned!.status).toBe("timed_out");
    });

    // AC10: getVideoAnalytics 例外時 → 同じく safe-by-default で skip reset
    it("falls back to skip reset (safe-by-default) when getVideoAnalytics throws", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      const original = ds.getVideoAnalytics.bind(ds);
      ds.getVideoAnalytics = async () => { throw new Error("simulated firestore timeout"); };
      try {
        const result = await forceExitSession(ds, session.id, "time_limit");
        expect(result.status).toBe("force_exited");
      } finally {
        ds.getVideoAnalytics = original;
      }

      // データ保護 (safe-by-default) のため quiz_attempts は cleanup のみ（削除されない）
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).not.toBeNull();
      expect(cleaned!.status).toBe("timed_out");
    });

    // AC11: video が削除済（lesson から外された）+ persistent isComplete=true
    //       → currentVideo=null なので永続フラグ無視、既存挙動（全リセット）
    it("ignores persistent completion when lesson video has been deleted (no replacement)", async () => {
      const { lesson, video: oldVideo, attempt } = await setupLessonWithInProgressAttempt("user1");
      await ds.upsertVideoAnalytics("user1", oldVideo.id, {
        coverageRatio: 0.98,
        isComplete: true,
        watchedRanges: [{ start: 0, end: 294 }],
        totalWatchTimeSec: 294,
        seekCount: 0,
        suspiciousFlags: [],
      });
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, oldVideo.id, "token-1");

      // 動画を削除（lesson は残るが video レコードがなくなる、差し替えなし）
      await ds.deleteVideo(oldVideo.id);

      await forceExitSession(ds, session.id, "time_limit");

      // currentVideo=null → 永続フラグ無視 → 全リセット
      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned).toBeNull();
    });
  });

  describe("completeSession", () => {
    it("sets status to completed with quiz attempt ID", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const completed = await completeSession(ds, session.id, "attempt-123");

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe("completed");
      expect(completed!.exitReason).toBe("quiz_submitted");
      expect(completed!.quizAttemptId).toBe("attempt-123");
      expect(completed!.exitAt).toBeTruthy();
    });

    // Issue #424 (Codex Medium 88): TOCTOU 縮小 - status が active でなければ skip (null を返す)
    it("Issue #424: session が abandoned に変化していたら skip して null を返す (TOCTOU 防御)", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // getLessonSession を mock して abandoned を返す (並行 abandon 後の状態)
      const originalGetLessonSession = ds.getLessonSession.bind(ds);
      ds.getLessonSession = async (id: string) => {
        const s = await originalGetLessonSession(id);
        if (s && s.id === session.id) {
          return { ...s, status: "abandoned" as const };
        }
        return s;
      };

      try {
        const result = await completeSession(ds, session.id, "attempt-456");

        expect(result).toBeNull();
        // 元 session の status は更新されていない (abandoned のまま)
        const verifyResult = await originalGetLessonSession(session.id);
        expect(verifyResult?.status).toBe("active"); // mock 経由ではない実 DS は active のまま
      } finally {
        ds.getLessonSession = originalGetLessonSession;
      }
    });

    it("Issue #424: session が completed (= 既に完了済) なら skip して null を返す", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 既に completed の状態 (mock)
      const originalGetLessonSession = ds.getLessonSession.bind(ds);
      ds.getLessonSession = async (id: string) => {
        const s = await originalGetLessonSession(id);
        if (s && s.id === session.id) {
          return { ...s, status: "completed" as const };
        }
        return s;
      };

      try {
        const result = await completeSession(ds, session.id, "attempt-789");
        expect(result).toBeNull();
      } finally {
        ds.getLessonSession = originalGetLessonSession;
      }
    });
  });

  describe("validateSessionDeadline", () => {
    it("returns true for session within deadline", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      expect(validateSessionDeadline(session)).toBe(true);
    });

    it("returns false for expired session", () => {
      const pastDeadline = new Date(Date.now() - 1000).toISOString();
      const session = {
        id: "test",
        userId: "user1",
        lessonId: "lesson1",
        courseId: "course1",
        videoId: "video1",
        sessionToken: "token",
        status: "active" as const,
        entryAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        exitAt: null,
        exitReason: null,
        deadlineAt: pastDeadline,
        pauseStartedAt: null,
        longestPauseSec: 0,
        sessionVideoCompleted: false,
        quizAttemptId: null,
        createdAt: "",
        updatedAt: "",
      };

      expect(validateSessionDeadline(session)).toBe(false);
    });
  });

  describe("abandonSession", () => {
    it("sets status to abandoned with browser_close reason", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      const abandoned = await abandonSession(ds, session.id);

      expect(abandoned.status).toBe("abandoned");
      expect(abandoned.exitReason).toBe("browser_close");
      expect(abandoned.exitAt).toBeTruthy();
    });

    it("does NOT reset lesson data (unlike forceExitSession)", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 学習データを作成
      await ds.upsertVideoAnalytics("user1", video.id, {
        coverageRatio: 0.5,
        isComplete: false,
        watchedRanges: [{ start: 0, end: 150 }],
        totalWatchTimeSec: 150,
        seekCount: 0,
        suspiciousFlags: [],
      });

      await abandonSession(ds, session.id);

      // video_analyticsがリセットされていないことを確認
      const analytics = await ds.getVideoAnalytics("user1", video.id);
      expect(analytics).not.toBeNull();
      expect(analytics!.coverageRatio).toBe(0.5);
    });

    it("allows creating a new session after abandoning", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");
      await abandonSession(ds, session.id);

      // abandoned後は getActiveLessonSession が null を返すため新規作成可能
      const active = await ds.getActiveLessonSession("user1", lesson.id);
      expect(active).toBeNull();

      const newSession = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-2");
      expect(newSession.id).not.toBe(session.id);
      expect(newSession.status).toBe("active");
    });

    it("throws when session does not exist", async () => {
      await expect(abandonSession(ds, "nonexistent-id")).rejects.toThrow("not found");
    });

    // Issue #422: abandonSession 後も in_progress attempt が残ると次回テスト開始不能になる
    it("cleans up in_progress quiz attempts to timed_out (browser_close path)", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      await abandonSession(ds, session.id);

      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned!.status).toBe("timed_out");
      expect(cleaned!.answers).toEqual({ q1: ["a"] }); // 証跡保持
    });

    it("allows creating a new attempt after abandon", async () => {
      const { lesson, video, quiz } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      await abandonSession(ds, session.id);

      const result = await ds.createQuizAttemptAtomic(
        quiz.id,
        "user1",
        quiz.maxAttempts,
        quiz.timeLimitSec,
        {
          quizId: quiz.id,
          userId: "user1",
          status: "in_progress",
          answers: {},
          score: null,
          isPassed: null,
          startedAt: new Date().toISOString(),
          submittedAt: null,
        }
      );
      expect(result).not.toBeNull();
      expect(result!.existing).toBe(false);
    });

    it("returns session as-is if already completed (TOCTOU safety)", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // テスト送信でセッション完了
      await ds.updateLessonSession(session.id, {
        status: "completed",
        exitAt: new Date().toISOString(),
        exitReason: "quiz_submitted",
      });

      // abandonは完了済みセッションを上書きしない
      const result = await abandonSession(ds, session.id);
      expect(result.status).toBe("completed");
    });
  });

  describe("handleStaleSession", () => {
    it("force-exits an expired active session", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      // 手動でdeadlineAtを過去に設定
      await ds.updateLessonSession(session.id, {
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });

      const stale = await ds.getLessonSession(session.id);
      const result = await handleStaleSession(ds, stale!);

      expect(result.status).toBe("force_exited");
      expect(result.exitReason).toBe("time_limit");
    });

    it("returns session as-is if not expired", async () => {
      const { lesson, video } = await setupLesson();
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      const result = await handleStaleSession(ds, session);
      expect(result.status).toBe("active");
    });

    // Issue #422: stale session を回収する際も in_progress attempt をクリーンアップする
    it("cleans up in_progress attempt when force-exiting stale session", async () => {
      const { lesson, video, attempt } = await setupLessonWithInProgressAttempt("user1");
      const session = await createSession(ds, "user1", lesson.id, lesson.courseId, video.id, "token-1");

      await ds.updateLessonSession(session.id, {
        sessionVideoCompleted: true,
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      });

      const stale = await ds.getLessonSession(session.id);
      await handleStaleSession(ds, stale!);

      const cleaned = await ds.getQuizAttemptById(attempt.id);
      expect(cleaned!.status).toBe("timed_out");
    });
  });
});
