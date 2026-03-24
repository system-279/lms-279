/**
 * Google Docsテストタブからのクイズインポートルーター
 * テスト文書を書式情報付きで読み取り、Geminiで構造パースしてプレビュー返却
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { isWorkspaceIntegrationAvailable } from "../../services/google-auth.js";
import {
  parseDocsUrl,
  getDocumentTabs,
  getDocumentTabContentFormatted,
} from "../../services/google-docs.js";
import {
  importQuizFromDocument,
  buildFormattedContentMarkup,
} from "../../services/quiz-import.js";

const router = Router();

/**
 * Google Docsテストタブからクイズをインポート（プレビュー用）
 * POST /admin/lessons/:lessonId/quiz/import
 *
 * ボディ:
 *   - docsUrl: string (必須) Google DocsのURL
 *   - tabId?: string (任意) インポート対象タブID（省略時はテストタブを自動検出）
 *
 * レスポンス:
 *   action: "select_tab" → タブ一覧を返却（テストタブ未検出時）
 *   action: "imported" → パース済みクイズを返却
 */
router.post(
  "/admin/lessons/:lessonId/quiz/import",
  requireAdmin,
  async (req: Request, res: Response) => {
    if (!isWorkspaceIntegrationAvailable()) {
      res.status(503).json({
        error: "workspace_not_configured",
        message: "Google Workspace integration is not configured",
      });
      return;
    }

    const ds = req.dataSource!;
    const lessonId = req.params.lessonId as string;
    const { docsUrl, tabId } = req.body;

    // バリデーション
    if (!docsUrl || typeof docsUrl !== "string") {
      res
        .status(400)
        .json({ error: "invalid_docsUrl", message: "docsUrl is required" });
      return;
    }

    // Docs URL解析
    let documentId: string;
    try {
      documentId = parseDocsUrl(docsUrl);
    } catch {
      res.status(400).json({
        error: "invalid_docsUrl",
        message: "Invalid Google Docs URL format",
      });
      return;
    }

    // レッスン存在チェック
    const lesson = await ds.getLessonById(lessonId);
    if (!lesson) {
      res
        .status(404)
        .json({ error: "not_found", message: "Lesson not found" });
      return;
    }

    // タブ解決
    let resolvedTabId = typeof tabId === "string" ? tabId : null;

    if (!resolvedTabId) {
      // テストタブを自動検出
      let docTitle: string;
      let tabs: { id: string; title: string }[];
      try {
        const result = await getDocumentTabs(documentId);
        docTitle = result.title;
        tabs = result.tabs;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to read document tabs";
        res.status(400).json({ error: "docs_read_failed", message });
        return;
      }

      // 「テスト」を含むタブを検索（大文字小文字無視）
      const testTab = tabs.find((t) =>
        t.title.toLowerCase().includes("テスト")
      );

      if (testTab) {
        resolvedTabId = testTab.id;
      } else {
        // テストタブが見つからない → タブ一覧を返却
        res.json({
          action: "select_tab" as const,
          tabs,
          documentTitle: docTitle,
        });
        return;
      }
    }

    // 書式付きコンテンツ取得
    let docTitle: string;
    let formattedMarkup: string;
    try {
      const result = await getDocumentTabContentFormatted(
        documentId,
        resolvedTabId
      );
      docTitle = result.title;
      formattedMarkup = buildFormattedContentMarkup(result.formattedContent);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to read tab content";
      const isTabNotFound =
        error instanceof Error && error.message.includes("Tab not found");
      res.status(isTabNotFound ? 400 : 500).json({
        error: isTabNotFound ? "tab_not_found" : "docs_read_failed",
        message,
      });
      return;
    }

    // Geminiでパース
    try {
      const { questions, warnings } = await importQuizFromDocument(
        formattedMarkup,
        { language: "ja" }
      );

      res.json({
        action: "imported" as const,
        importedQuestions: questions,
        documentTitle: docTitle,
        suggestedTitle: `${docTitle} - 確認テスト`,
        warnings,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Quiz import failed";

      const isTransient =
        error instanceof Error &&
        "status" in error &&
        [429, 503].includes((error as { status: number }).status);

      res.status(isTransient ? 503 : 500).json({
        error: "quiz_import_failed",
        message,
      });
    }
  }
);

export const quizImportRouter = router;
