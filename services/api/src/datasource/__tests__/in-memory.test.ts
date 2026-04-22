import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDataSource } from "../in-memory.js";
import { ReadOnlyDataSourceError } from "../interface.js";

// -----------------------------------------------
// InMemoryDataSource CRUD テスト
// -----------------------------------------------

describe("InMemoryDataSource", () => {
  // -----------------------------------------------
  // Courses
  // -----------------------------------------------

  describe("Courses", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("create: コースを作成してgetByIdで取得できる", async () => {
      const created = await ds.createCourse({
        name: "テストコース",
        description: "説明文",
        status: "draft",
        lessonOrder: [],
        passThreshold: 70,
        createdBy: "user-1",
      });

      expect(created.id).toMatch(/^course-/);
      expect(created.name).toBe("テストコース");
      expect(created.status).toBe("draft");

      const fetched = await ds.getCourseById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getById: 存在しないidはnullを返す", async () => {
      const result = await ds.getCourseById("non-existent");
      expect(result).toBeNull();
    });

    it("update: フィールドを更新できる", async () => {
      const created = await ds.createCourse({
        name: "変更前",
        description: null,
        status: "draft",
        lessonOrder: [],
        passThreshold: 70,
        createdBy: "user-1",
      });

      const updated = await ds.updateCourse(created.id, {
        name: "変更後",
        status: "published",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("変更後");
      expect(updated!.status).toBe("published");
    });

    it("update: 存在しないidはnullを返す", async () => {
      const result = await ds.updateCourse("non-existent", { name: "X" });
      expect(result).toBeNull();
    });

    it("delete: コースを削除できる", async () => {
      const created = await ds.createCourse({
        name: "削除対象",
        description: null,
        status: "draft",
        lessonOrder: [],
        passThreshold: 70,
        createdBy: "user-1",
      });

      const deleted = await ds.deleteCourse(created.id);
      expect(deleted).toBe(true);

      const fetched = await ds.getCourseById(created.id);
      expect(fetched).toBeNull();
    });

    it("delete: 存在しないidはfalseを返す", async () => {
      const result = await ds.deleteCourse("non-existent");
      expect(result).toBe(false);
    });

    it("filter by status: publishedのみ取得", async () => {
      // 初期データに published が2件、draft が1件ある
      const published = await ds.getCourses({ status: "published" });
      expect(published.every((c) => c.status === "published")).toBe(true);
      expect(published.length).toBeGreaterThanOrEqual(2);

      const draft = await ds.getCourses({ status: "draft" });
      expect(draft.every((c) => c.status === "draft")).toBe(true);
    });

    it("getCourses: フィルタなし → 全件取得", async () => {
      const all = await ds.getCourses();
      // 初期データは3件
      expect(all.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -----------------------------------------------
  // Lessons
  // -----------------------------------------------

  describe("Lessons", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("create: レッスンを作成してgetByIdで取得できる", async () => {
      const created = await ds.createLesson({
        courseId: "demo-course-1",
        title: "新レッスン",
        order: 10,
        hasVideo: true,
        hasQuiz: false,
        videoUnlocksPrior: false,
      });

      expect(created.id).toMatch(/^lesson-/);
      expect(created.title).toBe("新レッスン");

      const fetched = await ds.getLessonById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getByLessonId: courseIdでフィルタできる", async () => {
      const lessons = await ds.getLessons({ courseId: "demo-course-1" });
      expect(lessons.length).toBeGreaterThanOrEqual(2);
      expect(lessons.every((l) => l.courseId === "demo-course-1")).toBe(true);
    });

    it("getLessons: order昇順でソートされる", async () => {
      // demo-course-1 のレッスンはorder 0, 1
      const lessons = await ds.getLessons({ courseId: "demo-course-1" });
      for (let i = 1; i < lessons.length; i++) {
        expect(lessons[i].order).toBeGreaterThanOrEqual(lessons[i - 1].order);
      }
    });

    it("reorder: レッスン順序とcourseのlessonOrderを更新できる", async () => {
      const courseId = "demo-course-1";
      const newOrder = ["demo-lesson-2", "demo-lesson-1"];

      await ds.reorderLessons(courseId, newOrder);

      const lessons = await ds.getLessons({ courseId });
      expect(lessons[0].id).toBe("demo-lesson-2");
      expect(lessons[1].id).toBe("demo-lesson-1");

      const course = await ds.getCourseById(courseId);
      expect(course!.lessonOrder).toEqual(newOrder);
    });

    it("delete: レッスンを削除できる", async () => {
      const created = await ds.createLesson({
        courseId: "demo-course-1",
        title: "削除レッスン",
        order: 99,
        hasVideo: false,
        hasQuiz: false,
        videoUnlocksPrior: false,
      });

      const deleted = await ds.deleteLesson(created.id);
      expect(deleted).toBe(true);

      const fetched = await ds.getLessonById(created.id);
      expect(fetched).toBeNull();
    });
  });

  // -----------------------------------------------
  // Videos
  // -----------------------------------------------

  describe("Videos", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("create: 動画を作成してgetByIdで取得できる", async () => {
      const created = await ds.createVideo({
        lessonId: "lesson-1",
        courseId: "course-1",
        sourceType: "external_url",
        sourceUrl: "https://example.com/video.mp4",
        durationSec: 300,
        requiredWatchRatio: 0.95,
        speedLock: true,
      });

      expect(created.id).toMatch(/^video-/);
      expect(created.sourceUrl).toBe("https://example.com/video.mp4");

      const fetched = await ds.getVideoById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getByLessonId: lessonIdで動画を取得できる", async () => {
      const created = await ds.createVideo({
        lessonId: "test-lesson-x",
        courseId: "course-1",
        sourceType: "gcs",
        gcsPath: "gs://bucket/video.mp4",
        durationSec: 600,
        requiredWatchRatio: 0.8,
        speedLock: false,
      });

      const fetched = await ds.getVideoByLessonId("test-lesson-x");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getByLessonId: 存在しないlessonIdはnullを返す", async () => {
      const fetched = await ds.getVideoByLessonId("non-existent-lesson");
      expect(fetched).toBeNull();
    });

    it("update: フィールドを更新できる", async () => {
      const created = await ds.createVideo({
        lessonId: "lesson-upd",
        courseId: "course-1",
        sourceType: "external_url",
        sourceUrl: "https://example.com/old.mp4",
        durationSec: 100,
        requiredWatchRatio: 0.9,
        speedLock: true,
      });

      const updated = await ds.updateVideo(created.id, {
        durationSec: 200,
        speedLock: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.durationSec).toBe(200);
      expect(updated!.speedLock).toBe(false);
    });

    it("delete: 動画を削除できる", async () => {
      const created = await ds.createVideo({
        lessonId: "lesson-del",
        courseId: "course-1",
        sourceType: "external_url",
        sourceUrl: "https://example.com/del.mp4",
        durationSec: 100,
        requiredWatchRatio: 0.9,
        speedLock: true,
      });

      const deleted = await ds.deleteVideo(created.id);
      expect(deleted).toBe(true);

      const fetched = await ds.getVideoById(created.id);
      expect(fetched).toBeNull();
    });
  });

  // -----------------------------------------------
  // Quizzes
  // -----------------------------------------------

  describe("Quizzes", () => {
    let ds: InMemoryDataSource;

    const baseQuizData = {
      lessonId: "lesson-q1",
      courseId: "course-q1",
      title: "テスト問題集",
      passThreshold: 70,
      maxAttempts: 3,
      timeLimitSec: null as null,
      randomizeQuestions: false,
      randomizeAnswers: false,
      requireVideoCompletion: true,
      questions: [
        {
          id: "qq1",
          text: "問1",
          type: "single" as const,
          options: [
            { id: "a", text: "選択肢A", isCorrect: true },
            { id: "b", text: "選択肢B", isCorrect: false },
          ],
          points: 10,
          explanation: "解説",
        },
      ],
    };

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("create: テストを作成してgetByIdで取得できる", async () => {
      const created = await ds.createQuiz(baseQuizData);

      expect(created.id).toMatch(/^quiz-/);
      expect(created.title).toBe("テスト問題集");

      const fetched = await ds.getQuizById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getByLessonId: lessonIdでテストを取得できる", async () => {
      const created = await ds.createQuiz(baseQuizData);

      const fetched = await ds.getQuizByLessonId("lesson-q1");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getByLessonId: 存在しないlessonIdはnullを返す", async () => {
      const fetched = await ds.getQuizByLessonId("no-such-lesson");
      expect(fetched).toBeNull();
    });

    it("update: フィールドを更新できる", async () => {
      const created = await ds.createQuiz(baseQuizData);

      const updated = await ds.updateQuiz(created.id, {
        passThreshold: 80,
        title: "更新後タイトル",
      });

      expect(updated).not.toBeNull();
      expect(updated!.passThreshold).toBe(80);
      expect(updated!.title).toBe("更新後タイトル");
    });

    it("delete: テストを削除できる", async () => {
      const created = await ds.createQuiz(baseQuizData);

      const deleted = await ds.deleteQuiz(created.id);
      expect(deleted).toBe(true);

      const fetched = await ds.getQuizById(created.id);
      expect(fetched).toBeNull();
    });
  });

  // -----------------------------------------------
  // Quiz Attempts
  // -----------------------------------------------

  describe("Quiz Attempts", () => {
    let ds: InMemoryDataSource;

    const baseAttemptData = {
      quizId: "quiz-1",
      userId: "user-1",
      attemptNumber: 1,
      status: "in_progress" as const,
      answers: {},
      score: null as null,
      isPassed: null as null,
      startedAt: new Date().toISOString(),
      submittedAt: null as null,
    };

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("create: 受験記録を作成してgetByIdで取得できる", async () => {
      const created = await ds.createQuizAttempt(baseAttemptData);

      expect(created.id).toMatch(/^quiz-attempt-/);
      expect(created.quizId).toBe("quiz-1");
      expect(created.status).toBe("in_progress");

      const fetched = await ds.getQuizAttemptById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("getById: 存在しないidはnullを返す", async () => {
      const result = await ds.getQuizAttemptById("non-existent");
      expect(result).toBeNull();
    });

    it("update: statusとscoreを更新できる", async () => {
      const created = await ds.createQuizAttempt(baseAttemptData);

      const updated = await ds.updateQuizAttempt(created.id, {
        status: "submitted",
        score: 85,
        isPassed: true,
        submittedAt: new Date().toISOString(),
        answers: { qq1: ["a"] },
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("submitted");
      expect(updated!.score).toBe(85);
      expect(updated!.isPassed).toBe(true);
    });

    it("filter by userId: ユーザーの受験記録を取得できる", async () => {
      await ds.createQuizAttempt({ ...baseAttemptData, userId: "user-A" });
      await ds.createQuizAttempt({ ...baseAttemptData, userId: "user-A" });
      await ds.createQuizAttempt({ ...baseAttemptData, userId: "user-B" });

      const userAAttempts = await ds.getQuizAttempts({ userId: "user-A" });
      expect(userAAttempts).toHaveLength(2);
      expect(userAAttempts.every((a) => a.userId === "user-A")).toBe(true);
    });

    it("filter by status: in_progressのみ取得", async () => {
      const attempt1 = await ds.createQuizAttempt(baseAttemptData);
      await ds.createQuizAttempt(baseAttemptData);

      // attempt1 を submitted に更新
      await ds.updateQuizAttempt(attempt1.id, { status: "submitted" });

      const inProgress = await ds.getQuizAttempts({ status: "in_progress" });
      expect(inProgress.every((a) => a.status === "in_progress")).toBe(true);
    });

    it("filter by quizId: 特定テストの受験記録を取得できる", async () => {
      await ds.createQuizAttempt({ ...baseAttemptData, quizId: "quiz-X" });
      await ds.createQuizAttempt({ ...baseAttemptData, quizId: "quiz-Y" });

      const quizXAttempts = await ds.getQuizAttempts({ quizId: "quiz-X" });
      expect(quizXAttempts).toHaveLength(1);
      expect(quizXAttempts[0].quizId).toBe("quiz-X");
    });
  });

  // -----------------------------------------------
  // User Progress
  // -----------------------------------------------

  describe("User Progress", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("upsert: 新規作成して取得できる", async () => {
      const progress = await ds.upsertUserProgress("user-1", "lesson-1", {
        courseId: "course-1",
        videoCompleted: true,
        quizPassed: false,
        quizBestScore: null,
        lessonCompleted: false,
      });

      expect(progress.userId).toBe("user-1");
      expect(progress.lessonId).toBe("lesson-1");
      expect(progress.videoCompleted).toBe(true);

      const fetched = await ds.getUserProgress("user-1", "lesson-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.videoCompleted).toBe(true);
    });

    it("upsert: 既存レコードを上書きできる", async () => {
      await ds.upsertUserProgress("user-1", "lesson-1", {
        courseId: "course-1",
        videoCompleted: false,
        quizPassed: false,
        quizBestScore: null,
        lessonCompleted: false,
      });

      await ds.upsertUserProgress("user-1", "lesson-1", {
        videoCompleted: true,
        quizPassed: true,
        lessonCompleted: true,
      });

      const fetched = await ds.getUserProgress("user-1", "lesson-1");
      expect(fetched!.videoCompleted).toBe(true);
      expect(fetched!.quizPassed).toBe(true);
      expect(fetched!.lessonCompleted).toBe(true);
    });

    it("get: 存在しない場合はnullを返す", async () => {
      const result = await ds.getUserProgress("no-user", "no-lesson");
      expect(result).toBeNull();
    });

    it("getByCourse: courseIdでユーザーの進捗一覧を取得できる", async () => {
      await ds.upsertUserProgress("user-1", "lesson-1", {
        courseId: "course-A",
        videoCompleted: true,
        quizPassed: true,
        quizBestScore: 90,
        lessonCompleted: true,
      });
      await ds.upsertUserProgress("user-1", "lesson-2", {
        courseId: "course-A",
        videoCompleted: false,
        quizPassed: false,
        quizBestScore: null,
        lessonCompleted: false,
      });
      await ds.upsertUserProgress("user-1", "lesson-3", {
        courseId: "course-B", // 別コース
        videoCompleted: true,
        quizPassed: true,
        quizBestScore: 80,
        lessonCompleted: true,
      });

      const progresses = await ds.getUserProgressByCourse("user-1", "course-A");
      expect(progresses).toHaveLength(2);
      expect(progresses.every((p) => p.courseId === "course-A")).toBe(true);
    });
  });

  // -----------------------------------------------
  // Course Progress
  // -----------------------------------------------

  describe("Course Progress", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("upsert: 新規作成して取得できる", async () => {
      const progress = await ds.upsertCourseProgress("user-1", "course-1", {
        completedLessons: 1,
        totalLessons: 3,
        progressRatio: 1 / 3,
        isCompleted: false,
      });

      expect(progress.userId).toBe("user-1");
      expect(progress.courseId).toBe("course-1");
      expect(progress.completedLessons).toBe(1);
      expect(progress.totalLessons).toBe(3);

      const fetched = await ds.getCourseProgress("user-1", "course-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.completedLessons).toBe(1);
    });

    it("upsert: 既存レコードを上書きできる", async () => {
      await ds.upsertCourseProgress("user-1", "course-1", {
        completedLessons: 1,
        totalLessons: 2,
        progressRatio: 0.5,
        isCompleted: false,
      });

      await ds.upsertCourseProgress("user-1", "course-1", {
        completedLessons: 2,
        totalLessons: 2,
        progressRatio: 1.0,
        isCompleted: true,
      });

      const fetched = await ds.getCourseProgress("user-1", "course-1");
      expect(fetched!.completedLessons).toBe(2);
      expect(fetched!.isCompleted).toBe(true);
    });

    it("get: 存在しない場合はnullを返す", async () => {
      const result = await ds.getCourseProgress("no-user", "no-course");
      expect(result).toBeNull();
    });

    it("getByUser: ユーザーの全コース進捗を取得できる", async () => {
      await ds.upsertCourseProgress("user-X", "course-A", {
        completedLessons: 1,
        totalLessons: 2,
        progressRatio: 0.5,
        isCompleted: false,
      });
      await ds.upsertCourseProgress("user-X", "course-B", {
        completedLessons: 3,
        totalLessons: 3,
        progressRatio: 1.0,
        isCompleted: true,
      });
      await ds.upsertCourseProgress("user-Y", "course-A", {
        completedLessons: 0,
        totalLessons: 2,
        progressRatio: 0,
        isCompleted: false,
      });

      const progresses = await ds.getCourseProgressByUser("user-X");
      expect(progresses).toHaveLength(2);
      expect(progresses.every((p) => p.userId === "user-X")).toBe(true);
    });
  });

  // -----------------------------------------------
  // ReadOnlyモード
  // -----------------------------------------------

  describe("ReadOnlyモード", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      // デフォルトは readOnly=true
      ds = new InMemoryDataSource();
    });

    it("createCourse → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.createCourse({
          name: "X",
          description: null,
          status: "draft",
          lessonOrder: [],
          passThreshold: 70,
          createdBy: "u",
        })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("updateCourse → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.updateCourse("demo-course-1", { name: "Y" })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("deleteCourse → ReadOnlyDataSourceError をスロー", async () => {
      await expect(ds.deleteCourse("demo-course-1")).rejects.toThrow(
        ReadOnlyDataSourceError
      );
    });

    it("createLesson → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.createLesson({
          courseId: "c1",
          title: "L",
          order: 0,
          hasVideo: false,
          hasQuiz: false,
          videoUnlocksPrior: false,
        })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("createVideo → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.createVideo({
          lessonId: "l1",
          courseId: "c1",
          sourceType: "external_url",
          sourceUrl: "https://example.com",
          durationSec: 100,
          requiredWatchRatio: 0.9,
          speedLock: true,
        })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("createQuiz → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.createQuiz({
          lessonId: "l1",
          courseId: "c1",
          title: "Q",
          passThreshold: 70,
          maxAttempts: 3,
          timeLimitSec: null,
          randomizeQuestions: false,
          randomizeAnswers: false,
          requireVideoCompletion: true,
          questions: [],
        })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("upsertUserProgress → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.upsertUserProgress("u1", "l1", {
          courseId: "c1",
          videoCompleted: true,
          quizPassed: false,
          quizBestScore: null,
          lessonCompleted: false,
        })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("upsertCourseProgress → ReadOnlyDataSourceError をスロー", async () => {
      await expect(
        ds.upsertCourseProgress("u1", "c1", {
          completedLessons: 0,
          totalLessons: 1,
          progressRatio: 0,
          isCompleted: false,
        })
      ).rejects.toThrow(ReadOnlyDataSourceError);
    });

    it("読み取り操作は ReadOnly でも成功する", async () => {
      // getCourses, getCourseById などは readOnly でも動作する
      const courses = await ds.getCourses();
      expect(courses.length).toBeGreaterThan(0);

      const course = await ds.getCourseById("demo-course-1");
      expect(course).not.toBeNull();
    });
  });

  // -----------------------------------------------
  // AllowedEmails
  // -----------------------------------------------

  describe("AllowedEmails", () => {
    let ds: InMemoryDataSource;

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("deleteAllowedEmailByEmail はメールアドレスで削除できる", async () => {
      await ds.createAllowedEmail({ email: "test@example.com", note: "test" });
      expect(await ds.isEmailAllowed("test@example.com")).toBe(true);

      const result = await ds.deleteAllowedEmailByEmail("test@example.com");
      expect(result).toBe(true);
      expect(await ds.isEmailAllowed("test@example.com")).toBe(false);
    });

    it("deleteAllowedEmailByEmail は存在しないメールでfalseを返す", async () => {
      const result = await ds.deleteAllowedEmailByEmail("nonexistent@example.com");
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------
  // PlatformAuthErrorLog (Issue #299)
  // -----------------------------------------------

  describe("PlatformAuthErrorLog", () => {
    let ds: InMemoryDataSource;

    const baseLog = {
      email: "denied@example.com",
      tenantId: "__platform__",
      errorType: "super_admin_denied",
      reason: "not_super_admin" as string | null,
      errorMessage: "not registered",
      path: "/api/v2/super/tenants",
      method: "GET",
      userAgent: null as string | null,
      ipAddress: null as string | null,
      firebaseErrorCode: null as string | null,
      occurredAt: "2026-04-22T12:00:00.000Z",
    };

    beforeEach(() => {
      ds = new InMemoryDataSource({ readOnly: false });
    });

    it("createPlatformAuthErrorLog で書いた log が getPlatformAuthErrorLogs で読める（read-after-write）", async () => {
      await ds.createPlatformAuthErrorLog(baseLog);
      const logs = await ds.getPlatformAuthErrorLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].email).toBe("denied@example.com");
      expect(logs[0].id).toMatch(/^platform-auth-error-/);
    });

    it("getPlatformAuthErrorLogs は occurredAt 降順で返す", async () => {
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-22T10:00:00.000Z" });
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-22T12:00:00.000Z" });
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-22T11:00:00.000Z" });

      const logs = await ds.getPlatformAuthErrorLogs();
      expect(logs.map((l) => l.occurredAt)).toEqual([
        "2026-04-22T12:00:00.000Z",
        "2026-04-22T11:00:00.000Z",
        "2026-04-22T10:00:00.000Z",
      ]);
    });

    it("email filter は完全一致", async () => {
      await ds.createPlatformAuthErrorLog({ ...baseLog, email: "a@example.com" });
      await ds.createPlatformAuthErrorLog({ ...baseLog, email: "b@example.com" });

      const logs = await ds.getPlatformAuthErrorLogs({ email: "a@example.com" });
      expect(logs).toHaveLength(1);
      expect(logs[0].email).toBe("a@example.com");
    });

    it("startDate/endDate filter は inclusive で範囲外を除外", async () => {
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-20T00:00:00.000Z" });
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-21T00:00:00.000Z" });
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-23T00:00:00.000Z" });

      const logs = await ds.getPlatformAuthErrorLogs({
        startDate: new Date("2026-04-21T00:00:00.000Z"),
        endDate: new Date("2026-04-22T00:00:00.000Z"),
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].occurredAt).toBe("2026-04-21T00:00:00.000Z");
    });

    it("startDate > endDate は空配列", async () => {
      await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: "2026-04-22T00:00:00.000Z" });
      const logs = await ds.getPlatformAuthErrorLogs({
        startDate: new Date("2026-04-25T00:00:00.000Z"),
        endDate: new Date("2026-04-20T00:00:00.000Z"),
      });
      expect(logs).toEqual([]);
    });

    it("limit で件数制限（降順で最新を残す）", async () => {
      for (let i = 0; i < 5; i++) {
        await ds.createPlatformAuthErrorLog({ ...baseLog, occurredAt: `2026-04-22T1${i}:00:00.000Z` });
      }
      const logs = await ds.getPlatformAuthErrorLogs({ limit: 2 });
      expect(logs).toHaveLength(2);
      expect(logs[0].occurredAt).toBe("2026-04-22T14:00:00.000Z");
      expect(logs[1].occurredAt).toBe("2026-04-22T13:00:00.000Z");
    });

    it("空結果時は空配列を返す", async () => {
      const logs = await ds.getPlatformAuthErrorLogs();
      expect(logs).toEqual([]);
    });
  });
});
