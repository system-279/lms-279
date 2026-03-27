/**
 * テスト管理の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import type { QuizQuestion, QuizOption, QuestionType } from "../../types/entities.js";

const router = Router();

// ============================================================
// バリデーションヘルパー
// ============================================================

interface RawOption {
  id?: unknown;
  text?: unknown;
  isCorrect?: unknown;
}

interface RawQuestion {
  id?: unknown;
  text?: unknown;
  type?: unknown;
  options?: unknown;
  points?: unknown;
  explanation?: unknown;
}

function validateQuestions(questions: unknown[]): { valid: true; data: QuizQuestion[] } | { valid: false; error: string } {
  if (questions.length > 50) {
    return { valid: false, error: "questions must not exceed 50 items" };
  }

  const validated: QuizQuestion[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as RawQuestion;

    if (!q.id || typeof q.id !== "string" || (q.id as string).trim() === "") {
      return { valid: false, error: `questions[${i}].id is required` };
    }
    if (!q.text || typeof q.text !== "string" || (q.text as string).trim() === "") {
      return { valid: false, error: `questions[${i}].text is required` };
    }
    if (q.type !== "single" && q.type !== "multi") {
      return { valid: false, error: `questions[${i}].type must be "single" or "multi"` };
    }
    if (!Array.isArray(q.options) || q.options.length === 0) {
      return { valid: false, error: `questions[${i}].options must be a non-empty array` };
    }
    if (q.points === undefined || q.points === null || typeof q.points !== "number" || q.points < 0) {
      return { valid: false, error: `questions[${i}].points is required and must be a non-negative number` };
    }

    const options: QuizOption[] = [];
    for (let j = 0; j < (q.options as unknown[]).length; j++) {
      const o = (q.options as unknown[])[j] as RawOption;
      if (!o.id || typeof o.id !== "string" || (o.id as string).trim() === "") {
        return { valid: false, error: `questions[${i}].options[${j}].id is required` };
      }
      if (!o.text || typeof o.text !== "string" || (o.text as string).trim() === "") {
        return { valid: false, error: `questions[${i}].options[${j}].text is required` };
      }
      if (typeof o.isCorrect !== "boolean") {
        return { valid: false, error: `questions[${i}].options[${j}].isCorrect must be a boolean` };
      }
      options.push({ id: o.id as string, text: o.text as string, isCorrect: o.isCorrect as boolean });
    }

    // single typeの場合、isCorrect=trueが1つだけ
    if (q.type === "single") {
      const correctCount = options.filter((o) => o.isCorrect).length;
      if (correctCount !== 1) {
        return { valid: false, error: `questions[${i}]: single type must have exactly one correct option, found ${correctCount}` };
      }
    }

    validated.push({
      id: q.id as string,
      text: q.text as string,
      type: q.type as QuestionType,
      options,
      points: q.points as number,
      explanation: typeof q.explanation === "string" ? q.explanation : "",
    });
  }

  return { valid: true, data: validated };
}

// ============================================================
// 管理者向けエンドポイント
// ============================================================

/**
 * 管理者向け: テスト作成
 * POST /admin/lessons/:lessonId/quiz
 */
router.post("/admin/lessons/:lessonId/quiz", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;
  const {
    title,
    questions,
    passThreshold,
    maxAttempts,
    timeLimitSec,
    randomizeQuestions,
    randomizeAnswers,
    requireVideoCompletion,
  } = req.body;

  // レッスン存在チェック
  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "Lesson not found" });
    return;
  }

  // 既存テストチェック
  const existing = await ds.getQuizByLessonId(lessonId);
  if (existing) {
    res.status(409).json({ error: "quiz_already_exists", message: "A quiz already exists for this lesson" });
    return;
  }

  // title バリデーション
  if (!title || typeof title !== "string" || title.trim() === "") {
    res.status(400).json({ error: "invalid_title", message: "title is required" });
    return;
  }

  // questions バリデーション
  if (!Array.isArray(questions) || questions.length === 0) {
    res.status(400).json({ error: "invalid_questions", message: "questions must be a non-empty array" });
    return;
  }

  const questionsResult = validateQuestions(questions);
  if (!questionsResult.valid) {
    res.status(400).json({ error: "invalid_questions", message: questionsResult.error });
    return;
  }

  const quiz = await ds.createQuiz({
    lessonId,
    courseId: lesson.courseId,
    title: title.trim(),
    passThreshold: passThreshold ?? 70,
    maxAttempts: maxAttempts ?? 0,
    timeLimitSec: timeLimitSec ?? null,
    randomizeQuestions: randomizeQuestions ?? false,
    randomizeAnswers: randomizeAnswers ?? false,
    requireVideoCompletion: requireVideoCompletion ?? true,
    questions: questionsResult.data,
  });

  // lesson.hasQuiz = true に更新
  // 注意: 既にvideoCompleted+quizPassed=trueで完了扱いの受講者がいる場合、
  // テスト追加後もlessonCompleted=trueのまま残る（#94）。
  // 全ユーザー進捗のリセットが必要な場合は管理者操作で対応すること。
  await ds.updateLesson(lessonId, { hasQuiz: true });

  res.status(201).json({ quiz });
});

/**
 * 管理者向け: テスト更新
 * PATCH /admin/lessons/:lessonId/quiz
 */
router.patch("/admin/lessons/:lessonId/quiz", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;
  const {
    title,
    questions,
    passThreshold,
    maxAttempts,
    timeLimitSec,
    randomizeQuestions,
    randomizeAnswers,
    requireVideoCompletion,
  } = req.body;

  // テスト存在チェック
  const quiz = await ds.getQuizByLessonId(lessonId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found for this lesson" });
    return;
  }

  // title バリデーション（更新時は任意）
  if (title !== undefined && (typeof title !== "string" || title.trim() === "")) {
    res.status(400).json({ error: "invalid_title", message: "title must be a non-empty string" });
    return;
  }

  // questions バリデーション（更新時は任意）
  let validatedQuestions: QuizQuestion[] | undefined;
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length === 0) {
      res.status(400).json({ error: "invalid_questions", message: "questions must be a non-empty array" });
      return;
    }
    const questionsResult = validateQuestions(questions);
    if (!questionsResult.valid) {
      res.status(400).json({ error: "invalid_questions", message: questionsResult.error });
      return;
    }
    validatedQuestions = questionsResult.data;
  }

  const updated = await ds.updateQuiz(quiz.id, {
    ...(title !== undefined && { title: title.trim() }),
    ...(validatedQuestions !== undefined && { questions: validatedQuestions }),
    ...(passThreshold !== undefined && { passThreshold }),
    ...(maxAttempts !== undefined && { maxAttempts }),
    ...(timeLimitSec !== undefined && { timeLimitSec }),
    ...(randomizeQuestions !== undefined && { randomizeQuestions }),
    ...(randomizeAnswers !== undefined && { randomizeAnswers }),
    ...(requireVideoCompletion !== undefined && { requireVideoCompletion }),
  });

  res.json({ quiz: updated });
});

/**
 * 管理者向け: テスト削除
 * DELETE /admin/lessons/:lessonId/quiz
 */
router.delete("/admin/lessons/:lessonId/quiz", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;

  // テスト存在チェック
  const quiz = await ds.getQuizByLessonId(lessonId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found for this lesson" });
    return;
  }

  await ds.deleteQuiz(quiz.id);

  // lesson.hasQuiz = false に更新
  await ds.updateLesson(lessonId, { hasQuiz: false });

  res.status(204).send();
});

/**
 * 管理者向け: テスト詳細取得（正解付き）
 * GET /admin/lessons/:lessonId/quiz
 */
router.get("/admin/lessons/:lessonId/quiz", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const lessonId = req.params.lessonId as string;

  const quiz = await ds.getQuizByLessonId(lessonId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found for this lesson" });
    return;
  }

  // 管理者なので正解（isCorrect）を含む全情報を返す
  res.json({ quiz });
});

export const quizzesRouter = router;
