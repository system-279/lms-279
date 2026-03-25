import { describe, it, expect, beforeEach } from "vitest";
import { updateLessonProgress, updateCourseProgress } from "../progress.js";
import { InMemoryDataSource } from "../../datasource/in-memory.js";

// -----------------------------------------------
// progress.ts のテスト
// InMemoryDataSource を readOnly=false で使用
// -----------------------------------------------

describe("updateLessonProgress", () => {
  let ds: InMemoryDataSource;

  // InMemoryDataSource はデモ用初期データ（コース・レッスン）を持つ
  // テストでは demo-course-1 (lessonOrder: ["demo-lesson-1", "demo-lesson-2"]) を使用
  const COURSE_ID = "demo-course-1";
  const LESSON_ID = "demo-lesson-1";
  const USER_ID = "test-user-1";

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("新規作成: videoCompleted=true → user_progressが作成される", async () => {
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      videoCompleted: true,
    });

    const progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress).not.toBeNull();
    expect(progress!.userId).toBe(USER_ID);
    expect(progress!.lessonId).toBe(LESSON_ID);
    expect(progress!.courseId).toBe(COURSE_ID);
    expect(progress!.videoCompleted).toBe(true);
    expect(progress!.quizPassed).toBe(false);
    expect(progress!.lessonCompleted).toBe(false); // quizPassed=false なので未完了
  });

  it("更新: quizPassed=true → 既存のvideoCompleted=trueと組み合わせてlessonCompleted=true", async () => {
    // まず videoCompleted=true を記録
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      videoCompleted: true,
    });

    // 次に quizPassed=true を記録（videoCompleted は引き継がれる）
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      quizPassed: true,
    });

    const progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress!.videoCompleted).toBe(true);
    expect(progress!.quizPassed).toBe(true);
    expect(progress!.lessonCompleted).toBe(true);
  });

  it("quizBestScore: 高いスコアが保持される（Math.max）", async () => {
    // 1回目: スコア60
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      quizBestScore: 60,
    });

    let progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress!.quizBestScore).toBe(60);

    // 2回目: スコア80 → 80が保持される
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      quizBestScore: 80,
    });

    progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress!.quizBestScore).toBe(80);

    // 3回目: スコア70 → 80が保持される（lower score does not overwrite）
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      quizBestScore: 70,
    });

    progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress!.quizBestScore).toBe(80);
  });

  it("videoCompleted=trueのみ → lessonCompleted=false（テストあり前提）", async () => {
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      videoCompleted: true,
      quizPassed: false,
    });

    const progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress!.lessonCompleted).toBe(false);
  });

  it("videoCompleted=true, quizPassed=true → lessonCompleted=true", async () => {
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      videoCompleted: true,
      quizPassed: true,
    });

    const progress = await ds.getUserProgress(USER_ID, LESSON_ID);
    expect(progress!.lessonCompleted).toBe(true);
  });

  it("updateLessonProgress呼び出し後、コース進捗も更新される", async () => {
    // videoCompleted=true, quizPassed=true → lessonCompleted=true
    await updateLessonProgress(ds, USER_ID, LESSON_ID, COURSE_ID, {
      videoCompleted: true,
      quizPassed: true,
    });

    const courseProgress = await ds.getCourseProgress(USER_ID, COURSE_ID);
    expect(courseProgress).not.toBeNull();
    expect(courseProgress!.completedLessons).toBe(1);
  });
});

// -----------------------------------------------
// updateCourseProgress
// -----------------------------------------------

describe("updateCourseProgress", () => {
  let ds: InMemoryDataSource;

  // demo-course-1 のlessonOrder: ["demo-lesson-1", "demo-lesson-2"] (2レッスン)
  const COURSE_ID = "demo-course-1";
  const USER_ID = "test-user-2";

  beforeEach(() => {
    ds = new InMemoryDataSource({ readOnly: false });
  });

  it("1/2レッスン完了 → progressRatio=0.5, isCompleted=false", async () => {
    // demo-lesson-1 を完了済みにする
    await ds.upsertUserProgress(USER_ID, "demo-lesson-1", {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: true,
      quizBestScore: 90,
      lessonCompleted: true,
    });

    await updateCourseProgress(ds, USER_ID, COURSE_ID);

    const progress = await ds.getCourseProgress(USER_ID, COURSE_ID);
    expect(progress).not.toBeNull();
    expect(progress!.completedLessons).toBe(1);
    expect(progress!.totalLessons).toBe(2);
    expect(progress!.progressRatio).toBeCloseTo(0.5);
    expect(progress!.isCompleted).toBe(false);
  });

  it("2/2レッスン完了 → progressRatio=1.0, isCompleted=true", async () => {
    // 両レッスンを完了済みにする
    await ds.upsertUserProgress(USER_ID, "demo-lesson-1", {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: true,
      quizBestScore: 90,
      lessonCompleted: true,
    });
    await ds.upsertUserProgress(USER_ID, "demo-lesson-2", {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: true,
      quizBestScore: 80,
      lessonCompleted: true,
    });

    await updateCourseProgress(ds, USER_ID, COURSE_ID);

    const progress = await ds.getCourseProgress(USER_ID, COURSE_ID);
    expect(progress!.completedLessons).toBe(2);
    expect(progress!.totalLessons).toBe(2);
    expect(progress!.progressRatio).toBeCloseTo(1.0);
    expect(progress!.isCompleted).toBe(true);
  });

  it("0/2レッスン完了 → progressRatio=0, isCompleted=false", async () => {
    await updateCourseProgress(ds, USER_ID, COURSE_ID);

    const progress = await ds.getCourseProgress(USER_ID, COURSE_ID);
    expect(progress!.completedLessons).toBe(0);
    expect(progress!.totalLessons).toBe(2);
    expect(progress!.progressRatio).toBe(0);
    expect(progress!.isCompleted).toBe(false);
  });

  it("存在しないcourseId → 何もしない（エラーにならない）", async () => {
    await expect(
      updateCourseProgress(ds, USER_ID, "non-existent-course")
    ).resolves.toBeUndefined();
  });

  it("lessonCompleted=false のレッスンは進捗にカウントされない", async () => {
    // 進捗があるが lessonCompleted=false
    await ds.upsertUserProgress(USER_ID, "demo-lesson-1", {
      courseId: COURSE_ID,
      videoCompleted: true,
      quizPassed: false,
      quizBestScore: 60,
      lessonCompleted: false,
    });

    await updateCourseProgress(ds, USER_ID, COURSE_ID);

    const progress = await ds.getCourseProgress(USER_ID, COURSE_ID);
    expect(progress!.completedLessons).toBe(0);
    expect(progress!.progressRatio).toBe(0);
  });
});
