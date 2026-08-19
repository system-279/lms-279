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
