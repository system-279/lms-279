/**
 * Google Docsからのテスト自動生成ルーター
 * ドキュメント内容を読み取り、Gemini(Vertex AI)でテスト問題を生成
 * プレビュー用（保存はしない）
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { isWorkspaceIntegrationAvailable } from "../../services/google-auth.js";
import { parseDocsUrl, getDocumentContent } from "../../services/google-docs.js";
import { generateQuizQuestions } from "../../services/quiz-generator.js";

const router = Router();

/**
 * Google Docsからテスト問題を自動生成（プレビュー用）
 * POST /admin/lessons/:lessonId/quiz/generate
 * ボディ:
 *   - docsUrl: string (必須) Google DocsのURL
 *   - questionCount?: number (default 10, max 50)
 *   - language?: "ja" | "en" (default "ja")
 *   - difficulty?: "easy" | "medium" | "hard" (default "medium")
 */
router.post("/admin/lessons/:lessonId/quiz/generate", requireAdmin, async (req: Request, res: Response) => {
  if (!isWorkspaceIntegrationAvailable()) {
    res.status(503).json({
      error: "workspace_not_configured",
      message: "Google Workspace integration is not configured",
    });
    return;
  }

  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;
  const { docsUrl, questionCount, language, difficulty } = req.body;

  // バリデーション
  if (!docsUrl || typeof docsUrl !== "string") {
    res.status(400).json({ error: "invalid_docsUrl", message: "docsUrl is required" });
    return;
  }

  // Docs URL解析
  let documentId: string;
  try {
    documentId = parseDocsUrl(docsUrl);
  } catch {
    res.status(400).json({ error: "invalid_docsUrl", message: "Invalid Google Docs URL format" });
    return;
  }

  // レッスン存在チェック
  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "Lesson not found" });
    return;
  }

  // ドキュメント内容取得
  let docTitle: string;
  let docContent: string;
  try {
    const doc = await getDocumentContent(documentId);
    docTitle = doc.title;
    docContent = doc.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read document";
    res.status(400).json({ error: "docs_read_failed", message });
    return;
  }

  // テスト生成
  try {
    const questions = await generateQuizQuestions(docContent, {
      questionCount: typeof questionCount === "number" ? questionCount : undefined,
      language: language === "en" ? "en" : "ja",
      difficulty: ["easy", "medium", "hard"].includes(difficulty) ? difficulty : undefined,
    });

    res.json({
      generatedQuestions: questions,
      documentTitle: docTitle,
      suggestedTitle: `${docTitle} - テスト`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quiz generation failed";

    // transient/permanent分類
    const isTransient = error instanceof Error &&
      "status" in error && [429, 503].includes((error as { status: number }).status);

    res.status(isTransient ? 503 : 500).json({
      error: "quiz_generation_failed",
      message,
    });
  }
});

export const quizGenerationRouter = router;
