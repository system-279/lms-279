/**
 * 進捗トラッキングサービス
 * レッスン進捗・コース進捗の更新ロジック
 */

import type { DataSource } from "../datasource/index.js";

/**
 * レッスン完了判定の唯一の定義。
 * 動画視聴(videoCompleted)は常に必須。テストは「合格」または「スキップ」のいずれかで足りる
 * （テスト任意化: quizSkippedはquizPassedを上書きしない独立フラグ）。
 * テストなしレッスンは呼び出し元で quizPassed=true を渡す。
 *
 * services/routes/super-admin.ts の student-progress 手動編集APIは、
 * この式を再計算せず operator 指定の lessonCompleted をそのまま書く設計のため、
 * ここでの変更が自動で波及するのは updateCourseProgress 経由の集計のみ。
 */
export function computeLessonCompleted(p: {
  videoCompleted: boolean;
  quizPassed: boolean;
  quizSkipped: boolean;
}): boolean {
  return p.videoCompleted && (p.quizPassed || p.quizSkipped);
}

/**
 * レッスン進捗を更新し、コース進捗も連動更新
 */
export async function updateLessonProgress(
  ds: DataSource,
  userId: string,
  lessonId: string,
  courseId: string,
  update: {
    videoCompleted?: boolean;
    quizPassed?: boolean;
    quizBestScore?: number;
    quizSkipped?: boolean;
  }
): Promise<void> {
  // 1. 現在のuser_progress取得
  const current = await ds.getUserProgress(userId, lessonId);

  // 2. 更新データ作成
  const videoCompleted = update.videoCompleted ?? current?.videoCompleted ?? false;
  const quizPassed = update.quizPassed ?? current?.quizPassed ?? false;
  const quizBestScore = update.quizBestScore !== undefined
    ? Math.max(update.quizBestScore, current?.quizBestScore ?? 0)
    : current?.quizBestScore ?? null;
  const quizSkipped = update.quizSkipped ?? current?.quizSkipped ?? false;
  // quizSkippedAt は「初めてスキップが確定した時刻」のみを記録し、以後の更新では保持する。
  // 呼び出し元に時刻責務を持たせない（サーバ側の現在時刻を単一の真実とする）。
  const quizSkippedAt =
    current?.quizSkipped !== true && quizSkipped === true
      ? new Date().toISOString()
      : current?.quizSkippedAt ?? null;

  // 3. レッスン完了判定
  const lessonCompleted = computeLessonCompleted({ videoCompleted, quizPassed, quizSkipped });

  // 4. user_progress upsert
  await ds.upsertUserProgress(userId, lessonId, {
    courseId,
    videoCompleted,
    quizPassed,
    quizBestScore,
    quizSkipped,
    quizSkippedAt,
    lessonCompleted,
  });

  // 5. コース進捗更新
  await updateCourseProgress(ds, userId, courseId);
}

/**
 * コース進捗を再計算
 */
export async function updateCourseProgress(
  ds: DataSource,
  userId: string,
  courseId: string
): Promise<void> {
  // コースのレッスン一覧取得
  const course = await ds.getCourseById(courseId);
  if (!course) return;

  const totalLessons = course.lessonOrder.length;
  if (totalLessons === 0) return;

  // ユーザーの全レッスン進捗取得
  const progresses = await ds.getUserProgressByCourse(userId, courseId);

  // 動画もテストもないレッスンは自動的に完了扱い
  const lessons = await ds.getLessons({ courseId });
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));
  let completedLessons = progresses.filter((p) => p.lessonCompleted).length;
  for (const lessonId of course.lessonOrder) {
    const lesson = lessonMap.get(lessonId);
    if (lesson && !lesson.hasVideo && !lesson.hasQuiz) {
      // 進捗レコードがない or 未完了の場合でも、コンテンツがないので完了扱い
      const hasProgress = progresses.some((p) => p.lessonId === lessonId && p.lessonCompleted);
      if (!hasProgress) completedLessons++;
    }
  }
  const progressRatio = completedLessons / totalLessons;
  const isCompleted = completedLessons >= totalLessons;

  await ds.upsertCourseProgress(userId, courseId, {
    completedLessons,
    totalLessons,
    progressRatio,
    isCompleted,
  });
}
