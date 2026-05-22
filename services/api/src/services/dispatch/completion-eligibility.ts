/**
 * published コース全件母集合に対する受講者の 100% 完了判定を行う純粋関数。
 *
 * 設計仕様書 §3.x、FR-4 (改訂)、AC-1 に対応。
 * Codex Critical-2 反映: course_progress doc 不在 course は「未着手」扱い、
 * 「対象外」扱いにしてはならない (= 未着手者を 100% 完了と誤判定して送信する事故を防ぐ)。
 *
 * 完了条件 (FR-4 改訂):
 *   ① publishedCourses が 1 件以上ある
 *   ② publishedCourses の全 course に対して、courseProgress doc が存在し、
 *      isCompleted === true かつ totalLessons === lessonOrder.length である
 *
 *   - courseProgress doc 不在 → 未着手 → 不適格
 *   - isCompleted === false → 不適格
 *   - isCompleted === true だが totalLessons と lessonOrder.length が乖離 → 不適格
 *     (course 側で lesson 追加された後に進捗未更新の race を捕捉、Critical-2 反映)
 *
 * 本関数は Firestore 読み取りを行わない pure 関数。
 * 呼び出し側で publishedCourses (status="published") と該当 user の
 * courseProgress を取得して渡す。テスト容易性を優先する。
 */

import type { Course, CourseProgress } from "../../types/entities.js";

export type EligibilityCourseInput = Pick<Course, "id" | "lessonOrder">;

export type EligibilityCourseProgressInput = Pick<
  CourseProgress,
  "courseId" | "isCompleted" | "totalLessons" | "completedLessons"
>;

/**
 * 進捗スナップショット (shared-types `CompletionNotificationProgressSnapshot` と同 shape)。
 *
 * 不変条件: `eligible: true` を返した結果に同居する場合、ループ完走したことから
 * 必ず `coursesCompleted === coursesTotal === publishedCourses.length` が成立する。
 * Phase 4 で `completion_notifications.progressSnapshot` フィールドに直接格納するため
 * 同 shape を維持しているが、本関数の戻り値としては「部分完了状態」を表現することはない。
 */
export interface EligibilityProgressSnapshot {
  /** 全 published コースの completedLessons 合計 */
  completedLessons: number;
  /** 全 published コースの totalLessons 合計 */
  totalLessons: number;
  /** 完了済 course 数。eligible=true 時は coursesTotal と必ず一致 (上記不変条件) */
  coursesCompleted: number;
  /** 全 published course 数 */
  coursesTotal: number;
}

export type EligibilityIneligibleReason =
  | "no_published_courses"
  | "missing_progress"
  | "not_completed"
  | "lesson_count_mismatch";

export type EligibilityResult =
  | {
      eligible: true;
      /** 通知時点の published course ID 一覧 (案 C: 後からコース追加されても再送しない) */
      courseIdsSnapshot: string[];
      progressSnapshot: EligibilityProgressSnapshot;
    }
  | {
      eligible: false;
      reason: EligibilityIneligibleReason;
      /** 不適格を生んだ course ID (no_published_courses の場合は null) */
      ineligibleCourseId: string | null;
    };

export function evaluateCompletionEligibility(
  publishedCourses: EligibilityCourseInput[],
  courseProgresses: EligibilityCourseProgressInput[],
): EligibilityResult {
  if (publishedCourses.length === 0) {
    return {
      eligible: false,
      reason: "no_published_courses",
      ineligibleCourseId: null,
    };
  }

  const progressMap = new Map<string, EligibilityCourseProgressInput>();
  for (const progress of courseProgresses) {
    progressMap.set(progress.courseId, progress);
  }

  let completedLessonsSum = 0;
  let totalLessonsSum = 0;

  for (const course of publishedCourses) {
    const progress = progressMap.get(course.id);
    if (!progress) {
      return {
        eligible: false,
        reason: "missing_progress",
        ineligibleCourseId: course.id,
      };
    }
    if (!progress.isCompleted) {
      return {
        eligible: false,
        reason: "not_completed",
        ineligibleCourseId: course.id,
      };
    }
    if (progress.totalLessons !== course.lessonOrder.length) {
      return {
        eligible: false,
        reason: "lesson_count_mismatch",
        ineligibleCourseId: course.id,
      };
    }
    completedLessonsSum += progress.completedLessons;
    totalLessonsSum += progress.totalLessons;
  }

  return {
    eligible: true,
    // 入力 publishedCourses の順序を保持。呼び出し側で sort したい場合は事前 sort する。
    courseIdsSnapshot: publishedCourses.map((c) => c.id),
    progressSnapshot: {
      completedLessons: completedLessonsSum,
      totalLessons: totalLessonsSum,
      coursesCompleted: publishedCourses.length,
      coursesTotal: publishedCourses.length,
    },
  };
}
