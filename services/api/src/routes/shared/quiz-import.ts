/**
 * Google Docsテストタブからのテストインポートルーター
 * テスト文書を書式情報付きで読み取り、Geminiで構造パースしてプレビュー返却
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { isWorkspaceIntegrationAvailable } from "../../services/google-auth.js";
import { parseDocsUrl } from "../../services/google-docs.js";
import { resolveAndImportQuiz } from "../../services/quiz-import.js";

const router = Router();

/**
 * Google Docsテストタブからテストをインポート（プレビュー用）
 * POST /admin/lessons/:lessonId/quiz/import
 *
 * ボディ:
 *   - docsUrl: string (必須) Google DocsのURL
 *   - tabId?: string (任意) インポート対象タブID（省略時はテストタブを自動検出）
 *
 * レスポンス:
 *   action: "select_tab" → タブ一覧を返却（テストタブ未検出時）
 *   action: "imported" → パース済みテストを返却
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

    if (!docsUrl || typeof docsUrl !== "string") {
      res.status(400).json({ error: "invalid_docsUrl", message: "docsUrl is required" });
      return;
    }

    let documentId: string;
    try {
      documentId = parseDocsUrl(docsUrl);
    } catch {
      res.status(400).json({ error: "invalid_docsUrl", message: "Invalid Google Docs URL format" });
      return;
    }

    const lesson = await ds.getLessonById(lessonId);
    if (!lesson) {
      res.status(404).json({ error: "not_found", message: "Lesson not found" });
      return;
    }

    try {
      const result = await resolveAndImportQuiz(
        documentId,
        typeof tabId === "string" ? tabId : null,
        { language: "ja" }
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quiz import failed";
      const isTabNotFound = error instanceof Error && error.message.includes("Tab not found");
      const isTransient =
        error instanceof Error &&
        "status" in error &&
        [429, 503].includes((error as { status: number }).status);

      res.status(isTabNotFound ? 400 : isTransient ? 503 : 500).json({
        error: isTabNotFound ? "tab_not_found" : "quiz_import_failed",
        message,
      });
    }
  }
);

export const quizImportRouter = router;
