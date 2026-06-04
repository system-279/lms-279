/**
 * dispatch dry-run 関連 test 共通 fixture (Phase 4 α-7、safe-refactor M2)。
 *
 * 以下 3 つの test ファイルで個別重複していた `makeSettings` / `makeFixture` /
 * `partialProgress` / `completedProgress` を抽出。
 *   - services/api/src/services/dispatch/dry-run/__tests__/progress-report-dry-run.test.ts
 *   - services/api/src/services/dispatch/dry-run/__tests__/completion-notification-dry-run.test.ts
 *   - services/api/src/routes/super/__tests__/dispatch-dry-run.test.ts
 *
 * default 値は両レーン test で「skip されない正常パス」を表現:
 *   - publishedCourses: 1 件 (no_published_courses 回避)
 *   - ccConfig.completionNotificationEnabled: true (completion レーンの skip 回避)
 *   - info.active: true, info.progressReportEnabled: true (progress レーンの skip 回避)
 *
 * skip 系 test では呼び出し側で `partial` 引数を渡して上書きする。
 */

import type {
  DispatchSettings,
} from "@lms-279/shared-types";
import type { InMemoryTenantFixture } from "../../tenant-data-loader.js";

/** dispatch dry-run test 共通の固定 now (Phase 4 採用時刻) */
export const FIXTURE_NOW = new Date("2026-06-03T00:00:00.000Z");

/** dispatch dry-run test 共通の sender email */
export const FIXTURE_SENDER_EMAIL = "dxcollege@279279.net";

/**
 * dispatch dry-run test 共通の DispatchSettings fixture。
 *
 * `progressReport` は default に含めない (旧 completion テストの未指定形と一致)。
 * progress テストでは `makeSettings({ progressReport: { ... } })` で明示注入する。
 */
export function makeSettings(
  partial: Partial<DispatchSettings> = {},
): DispatchSettings {
  return {
    enabled: true,
    scheduleDaysOfWeek: [1, 4],
    scheduleHourJst: 9,
    signatureName: "DXcollege運営スタッフ",
    completionMessageBody: "受講お疲れ様でした。",
    senderEmail: FIXTURE_SENDER_EMAIL,
    updatedAt: "2026-05-20T00:00:00.000Z",
    updatedBy: "admin@279279.net",
    version: 1,
    ...partial,
  };
}

/**
 * dispatch dry-run test 共通の InMemoryTenantFixture base。
 *
 * default は両レーン test で「skip されない正常パス」を表現する形:
 *   - publishedCourses: 1 件 (no_published_courses 回避)
 *   - ccConfig: completion 有効、CC 0 件
 *   - info: active + progressReportEnabled: true (旧 progress テスト相当)
 *
 * 旧 completion テストの default `progressReportEnabled: false` は completion lane
 * のロジックで参照されないため、true 統一しても動作差分なし。
 */
export function makeFixture(
  partial: Partial<InMemoryTenantFixture> = {},
): InMemoryTenantFixture {
  return {
    publishedCourses: [{ id: "c1", lessonOrder: ["l1", "l2", "l3"] }],
    users: [],
    courseProgresses: new Map(),
    ccConfig: {
      completionNotificationEnabled: true,
      ownerEmail: null,
      notificationCcEmails: [],
    },
    info: { active: true, progressReportEnabled: true },
    ...partial,
  };
}

/**
 * progressRatio = 1/3 ≈ 33% の進捗。
 * `evaluateCompletionEligibility` で eligibility false。
 *
 * 進捗レーン: `wouldSendCount` に算入される対象。
 * 完了通知レーン: skip 対象 (100% 未満)。
 */
export function partialProgress(courseId = "c1") {
  return [
    { courseId, isCompleted: false, totalLessons: 3, completedLessons: 1 },
  ];
}

/**
 * progressRatio = 3/3 = 100% の進捗。
 * `evaluateCompletionEligibility` で eligibility true。
 *
 * 進捗レーン: skip 対象 (`completedCount` に算入、完了通知レーンがカバー済)。
 * 完了通知レーン: `wouldNotify` に算入される対象。
 */
export function completedProgress(courseId = "c1") {
  return [
    { courseId, isCompleted: true, totalLessons: 3, completedLessons: 3 },
  ];
}
