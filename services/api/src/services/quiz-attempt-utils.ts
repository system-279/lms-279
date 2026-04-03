/**
 * テスト受験ユーティリティ
 * Firestore/in-memory 共通ロジック
 */

import type { QuizAttempt } from "../types/entities.js";

/**
 * timed_out を除いた有効試行数を返す。
 * maxAttempts 判定に使用。timed_out は学習者の責任ではないため除外。
 */
export function countEffectiveAttempts(
  attempts: Pick<QuizAttempt, "status">[],
): number {
  return attempts.filter((a) => a.status !== "timed_out").length;
}
