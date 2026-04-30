/**
 * 受講期間管理サービス
 * テナント単位の期限チェックユーティリティ
 */

import { addMonths, addYears } from "date-fns";
import type { Request, Response } from "express";
import type { TenantEnrollmentSetting } from "../types/entities.js";

/** JST日末 (23:59:59.999 JST = 14:59:59.999 UTC)。入力はUTC基準のDateであること。 */
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
 * 起算日（enrolledAt または deadlineBaseDate）からデフォルトの期限を計算（JST日末基準）
 */
export function calculateDefaultDeadlines(baseDate: string): {
  quizAccessUntil: string;
  videoAccessUntil: string;
} {
  const base = new Date(baseDate);
  if (isNaN(base.getTime())) {
    throw new Error(`calculateDefaultDeadlines: invalid baseDate "${baseDate}"`);
  }

  // テスト: 起算日 + 2ヶ月（JST日末まで有効）
  const quizDeadline = endOfDayJST(addMonths(base, 2));

  // 動画: 起算日 + 1年（JST日末まで有効）
  const videoDeadline = endOfDayJST(addYears(base, 1));

  return {
    quizAccessUntil: quizDeadline.toISOString(),
    videoAccessUntil: videoDeadline.toISOString(),
  };
}

// `<input type="date">` 由来の `YYYY-MM-DD` と ISO datetime（末尾 Z 任意）を許容。
// super-admin.ts の `ISO_DATE_REGEX` は attendance 用で UTC `Z` 必須の別仕様。統合しない。
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?)?$/;
const ENROLLEDAT_RANGE_YEARS = 5;

function isValidISODate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value) && !isNaN(new Date(value).getTime());
}

function isWithinRange(dateStr: string): boolean {
  const diff = Math.abs(new Date(dateStr).getTime() - Date.now());
  return diff <= ENROLLEDAT_RANGE_YEARS * 365.25 * 24 * 60 * 60 * 1000;
}

export type ValidatedEnrollmentPayload = {
  ok: true;
  enrolledAt: string;
  deadlineBaseDate?: string;
};

export type ValidationError = {
  ok: false;
  status: 400;
  error: string;
  message: string;
};

/**
 * PUT /super/tenants/:tenantId/enrollment-setting の body を検証して正規化する。
 * - enrolledAt: 必須、ISO、5年範囲内
 * - deadlineBaseDate: 任意、空文字は未指定扱い、ISO、5年範囲内、enrolledAt 以前であること
 */
export function validateEnrollmentSettingPayload(body: unknown): ValidatedEnrollmentPayload | ValidationError {
  const payload = (body ?? {}) as { enrolledAt?: unknown; deadlineBaseDate?: unknown };
  const { enrolledAt, deadlineBaseDate } = payload;

  if (!enrolledAt || typeof enrolledAt !== "string") {
    return { ok: false, status: 400, error: "bad_request", message: "enrolledAt is required" };
  }
  if (!isValidISODate(enrolledAt)) {
    return { ok: false, status: 400, error: "invalid_date", message: "enrolledAt must be a valid date string" };
  }
  if (!isWithinRange(enrolledAt)) {
    return {
      ok: false, status: 400, error: "date_out_of_range",
      message: `enrolledAt must be within ${ENROLLEDAT_RANGE_YEARS} years from now`,
    };
  }

  const normalizedEnrolledAt = new Date(enrolledAt).toISOString();

  // 空文字・undefined は未指定扱い
  const hasDeadlineBaseDate = typeof deadlineBaseDate === "string" && deadlineBaseDate.length > 0;
  if (!hasDeadlineBaseDate) {
    return { ok: true, enrolledAt: normalizedEnrolledAt };
  }

  if (!isValidISODate(deadlineBaseDate)) {
    return { ok: false, status: 400, error: "invalid_date", message: "deadlineBaseDate must be a valid date string" };
  }
  if (!isWithinRange(deadlineBaseDate)) {
    return {
      ok: false, status: 400, error: "date_out_of_range",
      message: `deadlineBaseDate must be within ${ENROLLEDAT_RANGE_YEARS} years from now`,
    };
  }
  if (new Date(deadlineBaseDate).getTime() > new Date(enrolledAt).getTime()) {
    return {
      ok: false, status: 400, error: "invalid_deadline_base_date",
      message: "deadlineBaseDate must be on or before enrolledAt",
    };
  }

  return {
    ok: true,
    enrolledAt: normalizedEnrolledAt,
    deadlineBaseDate: new Date(deadlineBaseDate).toISOString(),
  };
}
