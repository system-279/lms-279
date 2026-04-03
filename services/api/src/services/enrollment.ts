/**
 * 受講期間管理サービス
 * テナント×コース単位の期限チェックユーティリティ
 */

import { addMonths, addYears } from "date-fns";
import type { Request, Response } from "express";
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
 * Route用ヘルパー: テスト受講期限を403でガード。
 * 期限切れの場合 res に 403 を送信し true を返す。呼び出し元は return すること。
 * エラー発生時は 500 を送信し true を返す。
 */
export async function guardQuizAccess(
  req: Request, res: Response, courseId: string,
): Promise<boolean> {
  try {
    const ds = req.dataSource!;
    const setting = await ds.getCourseEnrollmentSetting(courseId);
    const result = checkQuizAccess(setting);
    if (!result.allowed) {
      res.status(403).json({
        error: result.reason,
        message: "テスト受験期間が終了しています",
      });
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Failed to check quiz access for courseId ${courseId}:`, err);
    res.status(500).json({
      error: "enrollment_check_failed",
      message: "受講期限チェックが失敗しました",
    });
    return true;
  }
}

/**
 * Route用ヘルパー: 動画視聴期限を403でガード。
 * 期限切れの場合 res に 403 を送信し true を返す。呼び出し元は return すること。
 */
export async function guardVideoAccess(
  req: Request, res: Response, courseId: string,
): Promise<boolean> {
  try {
    const ds = req.dataSource!;
    const setting = await ds.getCourseEnrollmentSetting(courseId);
    const result = checkVideoAccess(setting);
    if (!result.allowed) {
      res.status(403).json({
        error: result.reason,
        message: "動画視聴期間が終了しています",
      });
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Failed to check video access for courseId ${courseId}:`, err);
    res.status(500).json({
      error: "enrollment_check_failed",
      message: "受講期限チェックが失敗しました",
    });
    return true;
  }
}

/**
 * Route用ヘルパー: テスト受講期限の事前検知（403しない）。
 * by-lesson エンドポイント用。期限切れでもレスポンスは返す。
 */
export async function checkQuizAccessSoft(
  req: Request, res: Response, courseId: string,
): Promise<{ accessExpired: boolean; expiredReason?: string } | null> {
  try {
    const ds = req.dataSource!;
    const setting = await ds.getCourseEnrollmentSetting(courseId);
    const result = checkQuizAccess(setting);
    if (!result.allowed) {
      return { accessExpired: true, expiredReason: result.reason };
    }
    return { accessExpired: false };
  } catch (err) {
    console.error(`Failed to check quiz access for courseId ${courseId}:`, err);
    res.status(500).json({
      error: "enrollment_check_failed",
      message: "受講期限チェックが失敗しました",
    });
    return null; // 呼び出し元は null なら return すること
  }
}

/**
 * enrolledAtからデフォルトの期限を計算
 */
export function calculateDefaultDeadlines(enrolledAt: string): {
  quizAccessUntil: string;
  videoAccessUntil: string;
} {
  const base = new Date(enrolledAt);
  if (isNaN(base.getTime())) {
    throw new Error(`calculateDefaultDeadlines: invalid enrolledAt "${enrolledAt}"`);
  }

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
