"use client";

import { useState } from "react";

interface QuizSkipButtonProps {
  /** テナントポリシーON + 動画完了済み + 未合格 + 受験中attemptなし。falseなら何も描画しない。 */
  skipAvailable: boolean;
  /** スキップ実行(POST /quizzes/:quizId/skip相当)を呼び出す関数。呼び出し元が状態更新まで担う。 */
  onSkip: () => Promise<void>;
}

/**
 * テスト任意化(テナント単位スキップ)のスキップボタン + 確認ダイアログ。
 *
 * PDFダウンロード可否は確定的に断定しない（テナントの資料ポリシーに従う、という抽象文言に留める）。
 * PDFゲート本体の実装はStage 4のため、Stage 3時点で「できます／できません」と確定表示すると、
 * Stage 4前にテナント管理者がポリシーをONにした場合に文言と実挙動が矛盾するリスクがある
 * (plan mode承認済み計画 floating-strolling-spindle.md 設計判断6、Codex plan review Critical指摘反映)。
 */
export function QuizSkipButton({
  skipAvailable,
  onSkip,
}: QuizSkipButtonProps): React.ReactElement | null {
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!skipAvailable) return null;

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      await onSkip();
      setShowConfirmDialog(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "テストのスキップに失敗しました。再度お試しください。"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowConfirmDialog(true)}
        className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-secondary"
      >
        テストをスキップする
      </button>

      {showConfirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-lg border shadow-lg p-6 w-full max-w-sm space-y-4 mx-4">
            <h3 className="text-base font-semibold">テストをスキップしますか？</h3>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
              <li>取り消しできません</li>
              <li>出席記録に「テストスキップ」として残ります</li>
              <li>資料PDFのダウンロード可否はテナントの資料ポリシーに従います</li>
            </ul>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowConfirmDialog(false)}
                disabled={loading}
                className="rounded-md border px-4 py-2 text-sm hover:bg-secondary disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={loading}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "処理中..." : "スキップする"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
