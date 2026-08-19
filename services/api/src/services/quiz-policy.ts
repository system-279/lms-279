import type { TenantQuizPolicy } from "../types/entities.js";

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

// Stage 4 で PDF ダウンロードゲートを実装する際、
// quizSkipEnabled && pdfDownloadAllowedForSkipped の AND を ad-hoc な条件式で
// 書かせないよう、ここに canDownloadPdfAfterQuizSkip(policy) 相当の名前付き純粋関数を追加する
// （codex plan review 指摘対応、実装計画 imperative-bubbling-dijkstra.md 設計判断6）。
// Stage 2 では未使用のため、実装は Stage 4 着手時まで見送る。
