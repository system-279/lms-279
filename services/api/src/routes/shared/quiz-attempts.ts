/**
 * テスト受験の共通ルーター
 * ADR-017: サーバーサイド採点、正解はsubmit後まで非公開
 * ADR-019: 動画完了ゲート
 */

import { Router, Request, Response } from "express";
import { requireUser } from "../../middleware/auth.js";
import { gradeQuiz, stripCorrectAnswers, randomizeQuiz } from "../../services/quiz-grading.js";
import { updateLessonProgress } from "../../services/progress.js";
import {
  validateSessionDeadline,
  forceExitSession,
  completeSession,
} from "../../services/lesson-session.js";
import { checkQuizAccess } from "../../services/enrollment.js";

const router = Router();

// ============================================================
// ヘルパー: 動画完了ゲートチェック（ADR-019）
// ============================================================

/**
 * quiz.requireVideoCompletion=true かつレッスンに動画がある場合、
 * 視聴完了チェックを行う。
 * 未完了の場合は403レスポンスを送信して true を返す（呼び出し元はreturnすること）。
 */
async function checkVideoCompletionGate(
  req: Request,
  res: Response,
  lessonId: string,
  userId: string
): Promise<boolean> {
  const ds = req.dataSource!;

  const video = await ds.getVideoByLessonId(lessonId);
  if (!video) {
    // 動画なしレッスン → ゲートなし
    return false;
  }

  const analytics = await ds.getVideoAnalytics(userId, video.id);
  if (!analytics || !analytics.isComplete) {
    res.status(403).json({
      error: "video_not_completed",
      message: "動画の視聴を完了してからテストに挑戦してください",
    });
    return true;
  }

  return false;
}

// ============================================================
// 受講者向けエンドポイント
// ============================================================

/**
 * 受講者向け: lessonIdによるテスト取得（正解なし）
 * GET /quizzes/by-lesson/:lessonId
 *
 * lessonId から quizId を解決するために使用。
 * 動画完了ゲートを適用した上でテスト情報と userAttemptCount を返す。
 */
router.get("/quizzes/by-lesson/:lessonId", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const lessonId = req.params.lessonId as string;

  const quiz = await ds.getQuizByLessonId(lessonId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found for this lesson" });
    return;
  }

  // 動画完了ゲート（ADR-019）
  if (quiz.requireVideoCompletion) {
    const blocked = await checkVideoCompletionGate(req, res, lessonId, userId);
    if (blocked) return;
  }

  // 受験履歴取得
  const attempts = await ds.getQuizAttempts({ quizId: quiz.id, userId });
  const userAttemptCount = attempts.length;

  // 正解を除去してランダム化
  const strippedQuestions = stripCorrectAnswers(quiz.questions);
  const randomizedQuestions = randomizeQuiz(
    strippedQuestions as Parameters<typeof randomizeQuiz>[0],
    quiz.randomizeQuestions,
    quiz.randomizeAnswers
  );

  // 過去の受験サマリー（正解は含まない）
  const attemptSummaries = attempts
    .filter((a) => a.status !== "in_progress")
    .map((a) => ({
      id: a.id,
      attemptNumber: a.attemptNumber,
      status: a.status,
      score: a.score,
      isPassed: a.isPassed,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
    }));

  res.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      passThreshold: quiz.passThreshold,
      maxAttempts: quiz.maxAttempts,
      timeLimitSec: quiz.timeLimitSec,
      questions: randomizedQuestions,
    },
    userAttemptCount,
    attemptSummaries,
  });
});

/**
 * 受講者向け: テスト取得（正解なし）
 * GET /quizzes/:quizId
 */
router.get("/quizzes/:quizId", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const quizId = req.params.quizId as string;

  const quiz = await ds.getQuizById(quizId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found" });
    return;
  }

  // 動画完了ゲート（ADR-019）
  if (quiz.requireVideoCompletion) {
    const blocked = await checkVideoCompletionGate(req, res, quiz.lessonId, userId);
    if (blocked) return;
  }

  // 受験回数取得
  const attempts = await ds.getQuizAttempts({ quizId, userId });
  const userAttemptCount = attempts.length;

  // 正解を除去してランダム化
  const strippedQuestions = stripCorrectAnswers(quiz.questions);
  const randomizedQuestions = randomizeQuiz(
    strippedQuestions as Parameters<typeof randomizeQuiz>[0],
    quiz.randomizeQuestions,
    quiz.randomizeAnswers
  );

  res.json({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      passThreshold: quiz.passThreshold,
      maxAttempts: quiz.maxAttempts,
      timeLimitSec: quiz.timeLimitSec,
      questions: randomizedQuestions,
    },
    userAttemptCount,
  });
});

/**
 * 受講者向け: テスト開始（attempt作成）
 * POST /quizzes/:quizId/attempts
 */
router.post("/quizzes/:quizId/attempts", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const quizId = req.params.quizId as string;

  const quiz = await ds.getQuizById(quizId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found" });
    return;
  }

  // 動画完了ゲート（ADR-019）
  if (quiz.requireVideoCompletion) {
    const blocked = await checkVideoCompletionGate(req, res, quiz.lessonId, userId);
    if (blocked) return;
  }

  // 受講期間チェック
  const enrollmentSetting = await ds.getCourseEnrollmentSetting(quiz.courseId);
  const quizAccessResult = checkQuizAccess(enrollmentSetting);
  if (!quizAccessResult.allowed) {
    res.status(403).json({
      error: quizAccessResult.reason,
      message: "テスト受験期間が終了しています",
    });
    return;
  }

  // 原子的にattempt作成（in_progress一意性 + attemptNumber採番 + maxAttemptsチェック）
  const result = await ds.createQuizAttemptAtomic(
    quizId, userId, quiz.maxAttempts, quiz.timeLimitSec,
    {
      quizId,
      userId,
      status: "in_progress",
      answers: {},
      score: null,
      isPassed: null,
      startedAt: new Date().toISOString(),
      submittedAt: null,
    }
  );

  if (result === null) {
    res.status(403).json({
      error: "max_attempts_exceeded",
      message: "受験可能な回数の上限に達しています",
    });
    return;
  }

  if (result.existing) {
    res.status(409).json({
      error: "attempt_in_progress",
      message: "現在進行中のテストがあります。先に提出してください",
    });
    return;
  }

  const attempt = result.attempt;
  res.status(201).json({
    attempt: {
      id: attempt.id,
      quizId: attempt.quizId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startedAt: attempt.startedAt,
      timeLimitSec: quiz.timeLimitSec,
    },
  });
});

/**
 * 受講者向け: テスト提出（採点）
 * PATCH /quiz-attempts/:attemptId
 */
router.patch("/quiz-attempts/:attemptId", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const attemptId = req.params.attemptId as string;

  const attempt = await ds.getQuizAttemptById(attemptId);
  if (!attempt) {
    res.status(404).json({ error: "not_found", message: "Quiz attempt not found" });
    return;
  }

  // 自分のattemptかチェック
  if (attempt.userId !== userId) {
    res.status(403).json({ error: "forbidden", message: "このattemptにアクセスする権限がありません" });
    return;
  }

  // status確認
  if (attempt.status !== "in_progress") {
    res.status(400).json({
      error: "attempt_not_in_progress",
      message: "このattemptはすでに提出済みまたはタイムアウトしています",
    });
    return;
  }

  const quiz = await ds.getQuizById(attempt.quizId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found" });
    return;
  }

  const now = new Date();
  const answers: Record<string, string[]> = req.body.answers ?? {};

  // セッション制限チェック（出席管理）
  // 設計上、セッション未作成（activeSession=null）の場合はテスト提出を許可する。
  // これにより出席管理導入前の受講者や、セッション機能未使用時の後方互換性を維持する。
  const activeSession = await ds.getActiveLessonSession(userId, quiz.lessonId);
  if (activeSession) {
    if (!validateSessionDeadline(activeSession)) {
      try {
        await forceExitSession(ds, activeSession.id, "time_limit");
      } catch (err) {
        console.error(`Failed to force-exit session (time_limit): ${activeSession.id}`, err);
      }
      res.status(403).json({
        error: "session_time_exceeded",
        message: "入室から2時間が経過したため、セッションが終了しました",
      });
      return;
    }
  }

  // 制限時間チェック
  if (quiz.timeLimitSec !== null) {
    const startedAt = new Date(attempt.startedAt);
    const deadlineMs = startedAt.getTime() + quiz.timeLimitSec * 1000;
    if (now.getTime() > deadlineMs) {
      // タイムアウト: 採点せずに timed_out で保存
      const timedOut = await ds.updateQuizAttempt(attemptId, {
        status: "timed_out",
        answers,
        score: null,
        isPassed: null,
        submittedAt: now.toISOString(),
      });
      res.json({
        attempt: {
          id: timedOut!.id,
          status: timedOut!.status,
          score: timedOut!.score,
          isPassed: timedOut!.isPassed,
          submittedAt: timedOut!.submittedAt,
        },
      });
      return;
    }
  }

  // 採点
  const gradingResult = gradeQuiz(quiz.questions, answers, quiz.passThreshold);

  const updated = await ds.updateQuizAttempt(attemptId, {
    status: "submitted",
    answers,
    score: gradingResult.score,
    isPassed: gradingResult.isPassed,
    submittedAt: now.toISOString(),
  });

  // レースコンディション対策: 採点後、進捗書き込み前にセッション状態を再確認
  // forceExitSessionが並行実行されていた場合、セッションはforce_exitedになり
  // レッスンデータもリセット済み。この場合、進捗書き込みをスキップする。
  if (activeSession) {
    try {
      const currentSession = await ds.getLessonSession(activeSession.id);
      if (!currentSession || currentSession.status === "force_exited") {
        res.status(409).json({
          error: "session_force_exited",
          message: "セッションが強制終了されたため、進捗には反映されません。再受講が必要です。",
          attempt: {
            id: updated!.id,
            status: updated!.status,
            score: updated!.score,
            isPassed: updated!.isPassed,
            submittedAt: updated!.submittedAt,
          },
        });
        return;
      }
    } catch (err) {
      // セッション再確認失敗時は楽観的に続行（レース検出より提出成功を優先）
      console.error(`Session re-check failed for session ${activeSession.id}, proceeding:`, err);
    }
  }

  // 合格した場合: 進捗更新 + 退室打刻
  if (gradingResult.isPassed) {
    if (quiz) {
      await updateLessonProgress(ds, userId, quiz.lessonId, quiz.courseId, {
        quizPassed: true,
        quizBestScore: gradingResult.score,
      });
    }

    // セッション完了（退室打刻）— 合格時のみ実行、不合格時は再挑戦可能
    if (activeSession) {
      try {
        await completeSession(ds, activeSession.id, updated!.id);
      } catch (err) {
        console.error(`Failed to complete session for attempt ${attemptId}:`, err);
      }
    }
  } else if (activeSession && quiz.maxAttempts > 0 && attempt.attemptNumber >= quiz.maxAttempts) {
    // 不合格 + 受験上限到達: セッションを強制退室（残留防止）
    try {
      await forceExitSession(ds, activeSession.id, "max_attempts_failed");
    } catch (err) {
      console.error(`Failed to force-exit session for max attempts ${attemptId}:`, err);
    }
  }

  res.json({
    attempt: {
      id: updated!.id,
      status: updated!.status,
      score: updated!.score,
      isPassed: updated!.isPassed,
      submittedAt: updated!.submittedAt,
    },
  });
});

/**
 * 受講者向け: 結果取得（正解・解説付き）
 * GET /quiz-attempts/:attemptId/result
 */
router.get("/quiz-attempts/:attemptId/result", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const attemptId = req.params.attemptId as string;

  const attempt = await ds.getQuizAttemptById(attemptId);
  if (!attempt) {
    res.status(404).json({ error: "not_found", message: "Quiz attempt not found" });
    return;
  }

  // 自分のattemptかチェック
  if (attempt.userId !== userId) {
    res.status(403).json({ error: "forbidden", message: "このattemptにアクセスする権限がありません" });
    return;
  }

  // 提出済みかチェック
  if (attempt.status !== "submitted" && attempt.status !== "timed_out") {
    res.status(400).json({
      error: "attempt_not_submitted",
      message: "テストはまだ提出されていません",
    });
    return;
  }

  const quiz = await ds.getQuizById(attempt.quizId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found" });
    return;
  }

  // 再採点して questionResults（各問の正誤、正解、解説）を生成
  const gradingResult = gradeQuiz(quiz.questions, attempt.answers, quiz.passThreshold);

  // 各問の解説を追加
  const questionResults = gradingResult.questionResults.map((qr) => {
    const question = quiz.questions.find((q) => q.id === qr.questionId);
    return {
      questionId: qr.questionId,
      questionText: question?.text ?? "",
      isCorrect: qr.isCorrect,
      earnedPoints: qr.earnedPoints,
      maxPoints: qr.maxPoints,
      correctOptionIds: qr.correctOptionIds,
      selectedOptionIds: qr.selectedOptionIds,
      explanation: question?.explanation ?? "",
    };
  });

  res.json({
    attempt: {
      id: attempt.id,
      quizId: attempt.quizId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      score: attempt.score,
      isPassed: attempt.isPassed,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
    },
    quiz: {
      title: quiz.title,
    },
    questionResults,
  });
});

export const quizAttemptsRouter = router;
