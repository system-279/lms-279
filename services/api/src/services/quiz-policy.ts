import type { TenantQuizPolicy } from "../types/entities.js";
import { parseBooleanEnv } from "../utils/env-config.js";

/**
 * テナントのテスト任意化設定を解決する（未設定 = 既定 OFF）。
 * ルート層と、Stage 3/4 で追加される受講者向けゲートロジックの両方から共用する
 * 単一の意味論解決ポイント（実装計画 imperative-bubbling-dijkstra.md 設計判断4）。
 */
export function resolveTenantQuizPolicy(policy: TenantQuizPolicy | null): {
  quizSkipEnabled: boolean;
  pdfDownloadAllowedForSkipped: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
} {
  if (!policy) {
    return {
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: false,
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    quizSkipEnabled: policy.quizSkipEnabled,
    pdfDownloadAllowedForSkipped: policy.pdfDownloadAllowedForSkipped,
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt,
  };
}

/**
 * スキップ済み受講者が講座資料PDFをダウンロードできるかを判定する（Stage 4）。
 * マスタースイッチ（quizSkipEnabled）が OFF の場合、サブ設定
 * （pdfDownloadAllowedForSkipped）の値が残っていてもダウンロードは許可しない
 * （設計判断6、AND を ad-hoc な条件式で書かせないための名前付き純粋関数）。
 */
export function canDownloadPdfAfterQuizSkip(policy: TenantQuizPolicy | null): boolean {
  const resolved = resolveTenantQuizPolicy(policy);
  return resolved.quizSkipEnabled && resolved.pdfDownloadAllowedForSkipped;
}

/**
 * テスト任意化 Stage 5(ケースD厳格化): `QUIZ_REQUIRE_ACTIVE_SESSION` の実効値を解決する
 * 単一の意味論解決ポイント（quiz-attempts.ts の POST/PATCH ゲートと、lessons.ts の
 * GET /lessons/:lessonId 応答（SessionRulesNotice の表示条件）の両方から共用する）。
 * デフォルト true（有効セッション必須）。毎呼び出しで評価する関数呼び出し方式にしている
 * 理由: モジュールスコープ定数にすると、既存テストの多く（createSharedRouter をファイル
 * 先頭で静的import）で flag=true/false 双方の挙動を同一ファイル内で検証できない
 * （モジュール初期化時点の process.env 値で凍結されるため）。
 */
export function isQuizActiveSessionRequired(): boolean {
  return parseBooleanEnv(process.env.QUIZ_REQUIRE_ACTIVE_SESSION, true, "QUIZ_REQUIRE_ACTIVE_SESSION");
}
