"use client";

import { useState } from "react";
import { Button } from "../ui/button";
import type {
  LessonResource,
  LessonPdfDownloadResponse,
} from "@lms-279/shared-types";

interface LessonPdfButtonProps {
  /** バックエンドから受け取った PDF メタ。未添付時は undefined。 */
  resource: LessonResource | undefined;
  /** 受講者の合格状態。当該レッスンの user_progress.quizPassed。 */
  quizPassed: boolean;
  /** 受講期間切れフラグ (videoAccessUntil 経過時)。 */
  videoAccessExpired?: boolean;
  /**
   * `/lessons/:lessonId/pdf-download` を叩く fetch 関数。
   * shared-types DTO に従って LessonPdfDownloadResponse を返す。
   */
  fetchDownloadUrl: () => Promise<LessonPdfDownloadResponse>;
}

/**
 * 講座資料スライド PDF のダウンロードボタン。
 *
 * 表示ルール (ADR-036 / docs/specs/2026-05-17-course-pdf-download-design.md):
 * - resource undefined: 何も表示しない (PDF 未添付レッスン)
 * - videoAccessExpired: 何も表示しない (受講期間終了後)
 * - quizPassed=false: disabled + 説明テキスト ("テスト合格後にダウンロード可能")
 * - quizPassed=true: enabled、クリックで署名 URL を取得し新タブで開く
 */
export function LessonPdfButton({
  resource,
  quizPassed,
  videoAccessExpired,
  fetchDownloadUrl,
}: LessonPdfButtonProps): React.ReactElement | null {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!resource) return null;
  if (videoAccessExpired) return null;

  const onClick = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDownloadUrl();
      // 新タブで開く。Content-Disposition により attachment として DL される。
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "ダウンロードに失敗しました。再度お試しください。",
      );
    } finally {
      setLoading(false);
    }
  };

  const sizeMb = (resource.pdfSizeBytes / (1024 * 1024)).toFixed(1);

  return (
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">講座資料 (PDF)</p>
          <p className="text-xs text-muted-foreground">
            {resource.pdfFileName} ({sizeMb} MB)
          </p>
        </div>
        <Button
          type="button"
          variant={quizPassed ? "default" : "outline"}
          disabled={!quizPassed || loading}
          onClick={onClick}
          aria-label="講座資料 PDF をダウンロード"
        >
          {loading ? "取得中..." : "資料をダウンロード"}
        </Button>
      </div>
      {!quizPassed && (
        <p className="text-xs text-muted-foreground">
          テスト合格後にダウンロードできます。
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
