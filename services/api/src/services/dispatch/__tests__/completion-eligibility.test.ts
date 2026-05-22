/**
 * completion-eligibility の単体テスト。
 *
 * 設計仕様書 §3.x、FR-4 (改訂)、AC-1 に対応。
 * Codex Critical-2 反映: course_progress doc 不在を「未着手」扱いで不適格に
 * することを保証する (= 未着手者を 100% 完了と誤判定して送信する事故を防ぐ)。
 *
 * 観点:
 *   - publishedCourses 0 件 → 不適格 (no_published_courses)
 *   - courseProgress 不在の course がある → 不適格 (missing_progress、Critical-2)
 *   - isCompleted=false の course がある → 不適格 (not_completed)
 *   - totalLessons と lessonOrder.length 不一致 → 不適格 (lesson_count_mismatch)
 *   - 全 publishedCourses が条件満たす → 適格 + snapshot
 *   - 余計な courseProgress (archived course 等) は無視される
 *   - courseIdsSnapshot は入力順序を保持する (呼び出し側 sort 責務)
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCompletionEligibility,
  type EligibilityCourseInput,
  type EligibilityCourseProgressInput,
} from "../completion-eligibility.js";

function course(
  id: string,
  lessonOrder: string[] = ["l1", "l2", "l3"],
): EligibilityCourseInput {
  return { id, lessonOrder };
}

function progress(
  courseId: string,
  options: Partial<EligibilityCourseProgressInput> = {},
): EligibilityCourseProgressInput {
  return {
    courseId,
    isCompleted: true,
    totalLessons: 3,
    completedLessons: 3,
    ...options,
  };
}

describe("evaluateCompletionEligibility", () => {
  describe("publishedCourses 0 件 (AC-1 母集合空)", () => {
    it("publishedCourses が空配列なら不適格 no_published_courses", () => {
      const result = evaluateCompletionEligibility([], []);
      expect(result).toEqual({
        eligible: false,
        reason: "no_published_courses",
        ineligibleCourseId: null,
      });
    });

    it("publishedCourses が空でも courseProgresses があれば courseProgresses は無視される", () => {
      const result = evaluateCompletionEligibility([], [progress("c1")]);
      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reason).toBe("no_published_courses");
      }
    });
  });

  describe("missing_progress (Critical-2 中核)", () => {
    it("published course に対応する progress doc が無ければ不適格", () => {
      const result = evaluateCompletionEligibility([course("c1"), course("c2")], [
        progress("c1"),
      ]);
      expect(result).toEqual({
        eligible: false,
        reason: "missing_progress",
        ineligibleCourseId: "c2",
      });
    });

    it("courseProgresses 全件不在 → 1 番目の course で不適格", () => {
      const result = evaluateCompletionEligibility([course("c1"), course("c2")], []);
      expect(result).toEqual({
        eligible: false,
        reason: "missing_progress",
        ineligibleCourseId: "c1",
      });
    });
  });

  describe("not_completed", () => {
    it("いずれかの course の isCompleted=false なら不適格", () => {
      const result = evaluateCompletionEligibility(
        [course("c1"), course("c2")],
        [progress("c1"), progress("c2", { isCompleted: false, completedLessons: 2 })],
      );
      expect(result).toEqual({
        eligible: false,
        reason: "not_completed",
        ineligibleCourseId: "c2",
      });
    });
  });

  describe("lesson_count_mismatch (stale snapshot race)", () => {
    it("isCompleted=true でも totalLessons と lessonOrder.length が乖離なら不適格", () => {
      // course に lesson が追加されたが、course_progress が更新前のスナップショット
      const result = evaluateCompletionEligibility(
        [course("c1", ["l1", "l2", "l3", "l4"])], // lessonOrder.length = 4
        [progress("c1", { totalLessons: 3, completedLessons: 3 })], // 古い 3 件のまま
      );
      expect(result).toEqual({
        eligible: false,
        reason: "lesson_count_mismatch",
        ineligibleCourseId: "c1",
      });
    });

    it("totalLessons が lessonOrder.length より大きいケースも不適格", () => {
      const result = evaluateCompletionEligibility(
        [course("c1", ["l1"])],
        [progress("c1", { totalLessons: 5, completedLessons: 5 })],
      );
      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reason).toBe("lesson_count_mismatch");
      }
    });
  });

  describe("適格 (全 published course が条件満たす)", () => {
    it("1 course、isCompleted=true、totalLessons 一致 → eligible", () => {
      const result = evaluateCompletionEligibility(
        [course("c1")],
        [progress("c1")],
      );
      expect(result).toEqual({
        eligible: true,
        courseIdsSnapshot: ["c1"],
        progressSnapshot: {
          completedLessons: 3,
          totalLessons: 3,
          coursesCompleted: 1,
          coursesTotal: 1,
        },
      });
    });

    it("複数 course、各 totalLessons 異なる → snapshot 合算", () => {
      const result = evaluateCompletionEligibility(
        [course("c1", ["l1", "l2"]), course("c2", ["l1", "l2", "l3", "l4"])],
        [
          progress("c1", { totalLessons: 2, completedLessons: 2 }),
          progress("c2", { totalLessons: 4, completedLessons: 4 }),
        ],
      );
      expect(result.eligible).toBe(true);
      if (result.eligible) {
        expect(result.courseIdsSnapshot).toEqual(["c1", "c2"]);
        expect(result.progressSnapshot).toEqual({
          completedLessons: 6,
          totalLessons: 6,
          coursesCompleted: 2,
          coursesTotal: 2,
        });
      }
    });

    it("入力順を保持する (sort は呼び出し側責務)", () => {
      const result = evaluateCompletionEligibility(
        [course("zebra"), course("apple")],
        [progress("zebra"), progress("apple")],
      );
      expect(result.eligible).toBe(true);
      if (result.eligible) {
        expect(result.courseIdsSnapshot).toEqual(["zebra", "apple"]);
      }
    });
  });

  describe("無関係な courseProgresses は無視", () => {
    it("courseProgresses に published 外の course (archived 等) が含まれても無視", () => {
      const result = evaluateCompletionEligibility(
        [course("c1")],
        [
          progress("c1"),
          progress("archived-course-id"), // published 外、影響なし
          progress("draft-course-id"),
        ],
      );
      expect(result.eligible).toBe(true);
      if (result.eligible) {
        expect(result.courseIdsSnapshot).toEqual(["c1"]);
        expect(result.progressSnapshot.coursesTotal).toBe(1);
      }
    });
  });
});
