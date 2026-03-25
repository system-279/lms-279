import { describe, it, expect, vi, beforeEach } from "vitest";
import { distributeCourseToTenant } from "../course-distributor.js";
import type { Course, Lesson, Video, Quiz } from "../../types/entities.js";

// -----------------------------------------------
// モック設定
// -----------------------------------------------

// FirestoreDataSource のモック
const mockGetCourseById = vi.fn();
const mockGetCourses = vi.fn();
const mockGetLessons = vi.fn();
const mockGetVideos = vi.fn();
const mockGetQuizzes = vi.fn();

vi.mock("../../datasource/firestore.js", () => {
  return {
    FirestoreDataSource: class MockFirestoreDataSource {
      tenantId: string;
      getCourseById = mockGetCourseById;
      getCourses = mockGetCourses;
      getLessons = mockGetLessons;
      getVideos = mockGetVideos;
      getQuizzes = mockGetQuizzes;
      constructor(_db: unknown, tenantId: string) {
        this.tenantId = tenantId;
      }
    },
  };
});

// -----------------------------------------------
// Firestore db モック
// -----------------------------------------------

let docIdCounter = 0;

function createMockDb(options?: {
  existingCourseId?: string;
}) {
  const batchSet = vi.fn();
  const batchCommit = vi.fn().mockResolvedValue(undefined);

  const mockBatch = {
    set: batchSet,
    commit: batchCommit,
  };

  // where().limit().get() のチェーン用
  const existingSnap = options?.existingCourseId
    ? { empty: false, docs: [{ id: options.existingCourseId }] }
    : { empty: true, docs: [] };

  const mockDb = {
    collection: vi.fn().mockReturnValue({
      doc: vi.fn().mockImplementation(() => {
        docIdCounter++;
        return { id: `generated-id-${docIdCounter}` };
      }),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue(existingSnap),
        }),
      }),
    }),
    batch: vi.fn().mockReturnValue(mockBatch),
  };

  return { mockDb, batchSet, batchCommit };
}

// -----------------------------------------------
// テストデータヘルパー
// -----------------------------------------------

function makeMasterCourse(overrides?: Partial<Course>): Course {
  return {
    id: "master-course-1",
    name: "テストコース",
    description: "テストコースの説明",
    status: "published",
    lessonOrder: ["lesson-1", "lesson-2"],
    passThreshold: 70,
    createdBy: "admin-user",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeLessons(): Lesson[] {
  return [
    {
      id: "lesson-1",
      courseId: "master-course-1",
      title: "レッスン1",
      order: 1,
      hasVideo: true,
      hasQuiz: true,
      videoUnlocksPrior: false,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
    {
      id: "lesson-2",
      courseId: "master-course-1",
      title: "レッスン2",
      order: 2,
      hasVideo: true,
      hasQuiz: false,
      videoUnlocksPrior: true,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
  ];
}

function makeVideos(): Video[] {
  return [
    {
      id: "video-1",
      lessonId: "lesson-1",
      courseId: "master-course-1",
      sourceType: "gcs",
      gcsPath: "courses/master/lesson1.mp4",
      durationSec: 600,
      requiredWatchRatio: 0.95,
      speedLock: true,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "video-2",
      lessonId: "lesson-2",
      courseId: "master-course-1",
      sourceType: "external_url",
      sourceUrl: "https://example.com/video2.mp4",
      gcsPath: undefined,
      durationSec: 300,
      requiredWatchRatio: 0.9,
      speedLock: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
}

function makeQuizzes(): Quiz[] {
  return [
    {
      id: "quiz-1",
      lessonId: "lesson-1",
      courseId: "master-course-1",
      title: "レッスン1テスト",
      passThreshold: 70,
      maxAttempts: 3,
      timeLimitSec: 1800,
      randomizeQuestions: true,
      randomizeAnswers: true,
      requireVideoCompletion: true,
      questions: [
        {
          id: "q1",
          text: "問題1",
          type: "single",
          options: [
            { id: "a", text: "選択肢A", isCorrect: true },
            { id: "b", text: "選択肢B", isCorrect: false },
          ],
          points: 10,
          explanation: "解説1",
        },
      ],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
}

// -----------------------------------------------
// テスト本体
// -----------------------------------------------

describe("distributeCourseToTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docIdCounter = 0;
  });

  // -------------------------------------------
  // 正常系: ディープコピーが正しく行われる
  // -------------------------------------------
  it("コース・レッスン・動画・テストがディープコピーされ、新しいIDが生成される", async () => {
    const masterCourse = makeMasterCourse();
    const lessons = makeLessons();
    const videos = makeVideos();
    const quizzes = makeQuizzes();

    mockGetCourseById.mockResolvedValue(masterCourse);
    mockGetLessons.mockResolvedValue(lessons);
    mockGetVideos.mockResolvedValue(videos);
    mockGetQuizzes.mockResolvedValue(quizzes);

    const { mockDb, batchSet } = createMockDb();

    const result = await distributeCourseToTenant(
      mockDb as never,
      "master-course-1",
      "tenant-abc",
      "distributor-user",
    );

    // ステータスとカウント
    expect(result.status).toBe("success");
    expect(result.tenantId).toBe("tenant-abc");
    expect(result.masterCourseId).toBe("master-course-1");
    expect(result.lessonsCount).toBe(2);
    expect(result.videosCount).toBe(2);
    expect(result.quizzesCount).toBe(1);

    // 新しいコースIDが生成されている（マスターIDと異なる）
    expect(result.courseId).toBeTruthy();
    expect(result.courseId).not.toBe("master-course-1");

    // バッチに書き込まれたデータを検証
    // 1(course) + 2(lessons) + 2(videos) + 1(quiz) = 6 operations
    expect(batchSet).toHaveBeenCalledTimes(6);

    // コースドキュメントの検証
    const courseCall = batchSet.mock.calls[0];
    const courseData = courseCall[1];
    expect(courseData.name).toBe("テストコース");
    expect(courseData.status).toBe("draft");
    expect(courseData.sourceMasterCourseId).toBe("master-course-1");
    expect(courseData.copiedAt).toBeInstanceOf(Date);
    expect(courseData.createdBy).toBe("distributor-user");

    // lessonOrderが新しいIDにリマップされている
    expect(courseData.lessonOrder).toHaveLength(2);
    expect(courseData.lessonOrder[0]).not.toBe("lesson-1");
    expect(courseData.lessonOrder[1]).not.toBe("lesson-2");

    // レッスンドキュメントの検証: courseIdが新しいIDにリマップされている
    const lessonCall1 = batchSet.mock.calls[1];
    const lessonData1 = lessonCall1[1];
    expect(lessonData1.courseId).toBe(result.courseId);
    expect(lessonData1.title).toBe("レッスン1");

    const lessonCall2 = batchSet.mock.calls[2];
    const lessonData2 = lessonCall2[1];
    expect(lessonData2.courseId).toBe(result.courseId);
    expect(lessonData2.title).toBe("レッスン2");

    // 動画ドキュメントの検証: lessonId, courseIdがリマップ + gcsPathは保持
    const videoCall1 = batchSet.mock.calls[3];
    const videoData1 = videoCall1[1];
    expect(videoData1.courseId).toBe(result.courseId);
    expect(videoData1.lessonId).not.toBe("lesson-1");
    expect(videoData1.gcsPath).toBe("courses/master/lesson1.mp4");

    const videoCall2 = batchSet.mock.calls[4];
    const videoData2 = videoCall2[1];
    expect(videoData2.courseId).toBe(result.courseId);
    expect(videoData2.lessonId).not.toBe("lesson-2");
    expect(videoData2.sourceUrl).toBe("https://example.com/video2.mp4");

    // テストドキュメントの検証: lessonId, courseIdがリマップ + questionsは保持
    const quizCall = batchSet.mock.calls[5];
    const quizData = quizCall[1];
    expect(quizData.courseId).toBe(result.courseId);
    expect(quizData.lessonId).not.toBe("lesson-1");
    expect(quizData.title).toBe("レッスン1テスト");
    expect(quizData.questions).toHaveLength(1);
    expect(quizData.questions[0].id).toBe("q1");
  });

  it("lessonOrderの各IDが対応するレッスンの新IDにリマップされる", async () => {
    const masterCourse = makeMasterCourse({
      lessonOrder: ["lesson-1", "lesson-2"],
    });
    const lessons = makeLessons();

    mockGetCourseById.mockResolvedValue(masterCourse);
    mockGetLessons.mockResolvedValue(lessons);
    mockGetVideos.mockResolvedValue([]);
    mockGetQuizzes.mockResolvedValue([]);

    const { mockDb, batchSet } = createMockDb();

    await distributeCourseToTenant(
      mockDb as never,
      "master-course-1",
      "tenant-abc",
      "distributor-user",
    );

    const courseData = batchSet.mock.calls[0][1];
    const lesson1Data = batchSet.mock.calls[1];
    const lesson2Data = batchSet.mock.calls[2];

    // lessonOrder[0] は lesson-1 の新IDと一致する
    const newLesson1Id = lesson1Data[0].id;
    const newLesson2Id = lesson2Data[0].id;
    expect(courseData.lessonOrder[0]).toBe(newLesson1Id);
    expect(courseData.lessonOrder[1]).toBe(newLesson2Id);
  });

  // -------------------------------------------
  // 重複配布の防止
  // -------------------------------------------
  it("同じコースを同じテナントに2回配布 → skippedが返る", async () => {
    mockGetCourseById.mockResolvedValue(makeMasterCourse());

    const { mockDb, batchSet } = createMockDb({
      existingCourseId: "existing-course-id",
    });

    const result = await distributeCourseToTenant(
      mockDb as never,
      "master-course-1",
      "tenant-abc",
      "distributor-user",
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already distributed");
    expect(result.courseId).toBe("existing-course-id");
    // バッチ書き込みは実行されない
    expect(batchSet).not.toHaveBeenCalled();
  });

  // -------------------------------------------
  // マスターコースが見つからない
  // -------------------------------------------
  it("マスターコースが存在しない → errorが返る", async () => {
    mockGetCourseById.mockResolvedValue(null);

    const { mockDb, batchSet } = createMockDb();

    const result = await distributeCourseToTenant(
      mockDb as never,
      "nonexistent-course",
      "tenant-abc",
      "distributor-user",
    );

    expect(result.status).toBe("error");
    expect(result.reason).toContain("マスターコースが見つかりません");
    expect(result.reason).toContain("nonexistent-course");
    expect(result.courseId).toBe("");
    expect(result.lessonsCount).toBe(0);
    expect(result.videosCount).toBe(0);
    expect(result.quizzesCount).toBe(0);
    expect(batchSet).not.toHaveBeenCalled();
  });

  // -------------------------------------------
  // 空コース（レッスンなし）
  // -------------------------------------------
  it("レッスンなしの空コース → コースのみコピーされカウントは全て0", async () => {
    const emptyCourse = makeMasterCourse({
      lessonOrder: [],
    });

    mockGetCourseById.mockResolvedValue(emptyCourse);
    mockGetLessons.mockResolvedValue([]);
    mockGetVideos.mockResolvedValue([]);
    mockGetQuizzes.mockResolvedValue([]);

    const { mockDb, batchSet } = createMockDb();

    const result = await distributeCourseToTenant(
      mockDb as never,
      "master-course-1",
      "tenant-abc",
      "distributor-user",
    );

    expect(result.status).toBe("success");
    expect(result.lessonsCount).toBe(0);
    expect(result.videosCount).toBe(0);
    expect(result.quizzesCount).toBe(0);
    // コースドキュメントのみ書き込まれる
    expect(batchSet).toHaveBeenCalledTimes(1);

    const courseData = batchSet.mock.calls[0][1];
    expect(courseData.lessonOrder).toEqual([]);
    expect(courseData.status).toBe("draft");
  });

  // -------------------------------------------
  // マスターコース取得時の例外
  // -------------------------------------------
  it("マスターコース取得で例外が発生 → errorが返る", async () => {
    mockGetCourseById.mockRejectedValue(new Error("Firestore connection error"));

    const { mockDb, batchSet } = createMockDb();

    const result = await distributeCourseToTenant(
      mockDb as never,
      "master-course-1",
      "tenant-abc",
      "distributor-user",
    );

    expect(result.status).toBe("error");
    expect(result.reason).toContain("マスターコースの取得に失敗しました");
    expect(result.reason).toContain("Firestore connection error");
    expect(batchSet).not.toHaveBeenCalled();
  });
});
