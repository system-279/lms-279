/**
 * 受講期間管理サービス
 * テナント×コース単位の期限チェックユーティリティ
 */

import { addMonths, addYears } from "date-fns";
import type { CourseEnrollmentSetting } from "../types/entities.js";

function endOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * テスト受験のアクセスチェック
 * setting未登録(null) → アクセス許可（後方互換）
 * setting登録済み → quizAccessUntilで判定
 */
export function checkQuizAccess(setting: CourseEnrollmentSetting | null): AccessCheckResult {
  if (!setting) return { allowed: true };

  const now = new Date();
  const deadline = new Date(setting.quizAccessUntil);

  if (isNaN(deadline.getTime())) {
    return { allowed: false, reason: "invalid_deadline_data" };
  }

  if (now >= deadline) {
    return { allowed: false, reason: "quiz_access_expired" };
  }

  return { allowed: true };
}

/**
 * 動画視聴のアクセスチェック
 * setting未登録(null) → アクセス許可（後方互換）
 * setting登録済み → videoAccessUntilで判定
 */
export function checkVideoAccess(setting: CourseEnrollmentSetting | null): AccessCheckResult {
  if (!setting) return { allowed: true };

  const now = new Date();
  const deadline = new Date(setting.videoAccessUntil);

  if (isNaN(deadline.getTime())) {
    return { allowed: false, reason: "invalid_deadline_data" };
  }

  if (now >= deadline) {
    return { allowed: false, reason: "video_access_expired" };
  }

  return { allowed: true };
}

/**
 * enrolledAtからデフォルトの期限を計算
 */
export function calculateDefaultDeadlines(enrolledAt: string): {
  quizAccessUntil: string;
  videoAccessUntil: string;
} {
  const base = new Date(enrolledAt);

  // テスト: enrolledAt + 2ヶ月（日末まで有効）
  // date-fns の addMonths は月末を正しくクランプする
  // 例: 1/31 + 2ヶ月 = 3/31, 12/31 + 2ヶ月 = 2/28(or 29)
  const quizDeadline = endOfDayUTC(addMonths(base, 2));

  // 動画: enrolledAt + 1年（日末まで有効）
  const videoDeadline = endOfDayUTC(addYears(base, 1));

  return {
    quizAccessUntil: quizDeadline.toISOString(),
    videoAccessUntil: videoDeadline.toISOString(),
  };
}
