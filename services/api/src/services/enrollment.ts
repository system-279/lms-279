/**
 * 受講期間管理サービス
 * テナント単位の期限チェックユーティリティ
 */

import { addMonths, addYears } from "date-fns";
import type { Request, Response } from "express";
import type { TenantEnrollmentSetting } from "../types/entities.js";

/** JST日末 (23:59:59.999 JST = 14:59:59.999 UTC) */
function endOfDayJST(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(14, 59, 59, 999);
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
export function checkQuizAccess(setting: TenantEnrollmentSetting | null): AccessCheckResult {
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
export function checkVideoAccess(setting: TenantEnrollmentSetting | null): AccessCheckResult {
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
 */
export async function guardQuizAccess(
  req: Request, res: Response,
): Promise<boolean> {
  try {
    const ds = req.dataSource!;
    const setting = await ds.getTenantEnrollmentSetting();
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
    console.error("Failed to check quiz access:", err);
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
  req: Request, res: Response,
): Promise<boolean> {
  try {
    const ds = req.dataSource!;
    const setting = await ds.getTenantEnrollmentSetting();
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
    console.error("Failed to check video access:", err);
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
  req: Request, res: Response,
): Promise<{ accessExpired: boolean; expiredReason?: string } | null> {
  try {
    const ds = req.dataSource!;
    const setting = await ds.getTenantEnrollmentSetting();
    const result = checkQuizAccess(setting);
    if (!result.allowed) {
      return { accessExpired: true, expiredReason: result.reason };
    }
    return { accessExpired: false };
  } catch (err) {
    console.error("Failed to check quiz access:", err);
    res.status(500).json({
      error: "enrollment_check_failed",
      message: "受講期限チェックが失敗しました",
    });
    return null;
  }
}

/**
 * enrolledAtからデフォルトの期限を計算（JST日末基準）
 */
export function calculateDefaultDeadlines(enrolledAt: string): {
  quizAccessUntil: string;
  videoAccessUntil: string;
} {
  const base = new Date(enrolledAt);
  if (isNaN(base.getTime())) {
    throw new Error(`calculateDefaultDeadlines: invalid enrolledAt "${enrolledAt}"`);
  }

  // テスト: enrolledAt + 2ヶ月（JST日末まで有効）
  const quizDeadline = endOfDayJST(addMonths(base, 2));

  // 動画: enrolledAt + 1年（JST日末まで有効）
  const videoDeadline = endOfDayJST(addYears(base, 1));

  return {
    quizAccessUntil: quizDeadline.toISOString(),
    videoAccessUntil: videoDeadline.toISOString(),
  };
}
