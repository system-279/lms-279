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
  forceExitSession,
  completeSession,
  completeSessionAsQuizSkipped,
  createSyntheticCompletedSession,
  createSyntheticSkippedSession,
  resolveActiveSessionForQuiz,
} from "../../services/lesson-session.js";
import { resolveTenantQuizPolicy, isQuizActiveSessionRequired } from "../../services/quiz-policy.js";
import { guardQuizAccess, checkQuizAccessSoft } from "../../services/enrollment.js";
import { logger } from "../../utils/logger.js";

const router = Router();

// ============================================================
// ヘルパー: 動画完了ゲートチェック（ADR-019）
// ============================================================

/**
 * レッスンに動画がある場合は視聴完了しているかを問い合わせのみ行う（副作用なし）。
 * 動画なしレッスンは「ゲート対象外」の意味で true（完了扱い）を返す。
 * テスト任意化 Stage 3: `checkVideoCompletionGate` と `skipAvailable` 算出の両方から共用する。
 */
async function isVideoCompletedOrNotRequired(
  req: Request,
  lessonId: string,
  userId: string
): Promise<boolean> {
  const ds = req.dataSource!;
  const video = await ds.getVideoByLessonId(lessonId);
  if (!video) {
    // 動画なしレッスン → ゲート対象外
    return true;
  }
  const analytics = await ds.getVideoAnalytics(userId, video.id);
  return analytics?.isComplete === true;
}

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
  const completed = await isVideoCompletedOrNotRequired(req, lessonId, userId);
  if (!completed) {
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

  // 受講期限チェック（#220）— ソフトチェック（403しない、フラグのみ）
  const enrollmentResult = await checkQuizAccessSoft(req, res);
  if (!enrollmentResult) return; // 500送信済み
  const { accessExpired, expiredReason } = enrollmentResult;

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

  // テスト任意化 Stage 3: skipAvailable / quizSkipped / pdfDownloadAllowedForSkipped
  const [tenantQuizPolicy, progress] = await Promise.all([
    ds.getTenantQuizPolicy(),
    ds.getUserProgress(userId, lessonId),
  ]);
  const { quizSkipEnabled, pdfDownloadAllowedForSkipped } = resolveTenantQuizPolicy(tenantQuizPolicy);
  const quizSkipped = progress?.quizSkipped === true;
  const hasPassed = progress?.quizPassed === true;
  const hasInProgressAttempt = attempts.some((a) => a.status === "in_progress");
  const videoCompleted = await isVideoCompletedOrNotRequired(req, lessonId, userId);
  const skipAvailable =
    quizSkipEnabled && !quizSkipped && !hasPassed && !hasInProgressAttempt && videoCompleted;

  // テスト任意化 Stage 5(ケースD厳格化): retakeBlocked(=合格済み)。
  // sessionRequired は GET /lessons/:lessonId (StudentLessonDetailResponse) 側にのみ持たせる
  // (SessionRulesNotice の表示条件として唯一そちらで消費されるため。当初こちらにも同名フィールドを
  // 追加したが FE から一切参照されず、動画有無を求める getVideoByLessonId の呼び出しが
  // isVideoCompletedOrNotRequired と重複するだけの無駄なクエリだった。second opinion レビュー指摘反映)
  const retakeBlocked = hasPassed;

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
    accessExpired,
    ...(accessExpired && { expiredReason }),
    skipAvailable,
    quizSkipped,
    pdfDownloadAllowedForSkipped,
    retakeBlocked,
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

  // 受講期限チェック（#220）
  const blocked = await guardQuizAccess(req, res);
  if (blocked) return;

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
  const enrollBlocked = await guardQuizAccess(req, res);
  if (enrollBlocked) return;

  // テスト任意化 Stage 5(ケースD厳格化): 合格済みなら再受験不可（flagに依存せず常時適用。
  // 合格を失うバグ経路の封鎖でもあるため、有効セッション必須化とは独立に効かせる）
  const progressForRetakeCheck = await ds.getUserProgress(userId, quiz.lessonId);
  if (progressForRetakeCheck?.quizPassed === true) {
    res.status(409).json({
      error: "quiz_already_passed",
      message: "既に合格しています",
    });
    return;
  }

  // テスト任意化 Stage 5(ケースD厳格化): 有効セッション必須化（デフォルトON）。
  // 動画なしレッスンは免除する（FEはセッションを動画play時にしか作らず、動画なし
  // レッスンでは POST /lesson-sessions に必要な videoId が存在しないため）。
  if (isQuizActiveSessionRequired()) {
    const video = await ds.getVideoByLessonId(quiz.lessonId);
    if (video) {
      const sessionState = await resolveActiveSessionForQuiz(ds, userId, quiz.lessonId);
      if (sessionState.kind === "expired") {
        try {
          await forceExitSession(ds, sessionState.session.id, "time_limit");
        } catch (err) {
          console.error(`Failed to force-exit session (time_limit): ${sessionState.session.id}`, err);
        }
        res.status(403).json({
          error: "session_time_exceeded",
          message: "セッション制限時間を超過したため、セッションが終了しました",
        });
        return;
      }
      if (sessionState.kind === "none") {
        res.status(409).json({
          error: "session_required",
          message: "動画を再生してレッスンセッションを開始してから受験してください",
        });
        return;
      }
    }
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
 * 受講者向け: テストスキップ（テスト任意化 Stage 3）
 * POST /quizzes/:quizId/skip
 *
 * ゲート順序（plan mode 承認済み計画 floating-strolling-spindle.md 参照）:
 *   quiz 存在確認(404) → 既にスキップ済みなら 200 冪等（他ゲートより前） →
 *   ポリシー OFF(403) → 動画完了無条件(403) → 受講期限(403) →
 *   合格済み(409) → in_progress attempt(409) → 本処理
 *
 * 冪等判定を他ゲートより前に置く理由: 1 回目のスキップ成功後にテナント側で
 * ポリシーを OFF に戻したり受講期限が経過したりしても、2 回目の同一呼び出しは
 * 常に 200 を維持する（Codex plan review Critical 指摘反映）。
 *
 * POST /quizzes/:quizId/attempts は変更しない。quizSkipped=true 後でも
 * 受験開始・合格提出は意図的に許容する（quizPassed && quizSkipped の併存を許す設計）。
 */
router.post("/quizzes/:quizId/skip", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const quizId = req.params.quizId as string;

  const quiz = await ds.getQuizById(quizId);
  if (!quiz) {
    res.status(404).json({ error: "not_found", message: "Quiz not found" });
    return;
  }

  // 冪等判定（他ゲートより前）: 既にスキップ済みなら以降のゲート状態に関わらず 200
  const existingProgress = await ds.getUserProgress(userId, quiz.lessonId);
  if (existingProgress?.quizSkipped === true) {
    res.json({
      quizSkipped: true,
      lessonCompleted: existingProgress.lessonCompleted,
      sessionRecorded: true,
    });
    return;
  }

  // テナントポリシー確認
  const tenantQuizPolicy = await ds.getTenantQuizPolicy();
  const { quizSkipEnabled } = resolveTenantQuizPolicy(tenantQuizPolicy);
  if (!quizSkipEnabled) {
    res.status(403).json({
      error: "quiz_skip_disabled",
      message: "このテストはスキップできません",
    });
    return;
  }

  // 動画完了ゲート（requireVideoCompletion の値によらず無条件適用。設計判断 2）
  const blocked = await checkVideoCompletionGate(req, res, quiz.lessonId, userId);
  if (blocked) return;

  // 受講期限チェック
  const enrollBlocked = await guardQuizAccess(req, res);
  if (enrollBlocked) return;

  // 合格済みなら「スキップ」に劣化させない
  if (existingProgress?.quizPassed === true) {
    res.status(409).json({
      error: "quiz_already_passed",
      message: "既に合格しています",
    });
    return;
  }

  // 受験中の attempt があれば先に提出させる
  const attempts = await ds.getQuizAttempts({ quizId, userId });
  if (attempts.some((a) => a.status === "in_progress")) {
    res.status(409).json({
      error: "attempt_in_progress",
      message: "現在進行中のテストがあります。先に提出してください",
    });
    return;
  }

  // 進捗確定（quizSkippedAt のタイムスタンプ責務は updateLessonProgress 内部が持つ）
  await updateLessonProgress(ds, userId, quiz.lessonId, quiz.courseId, {
    quizSkipped: true,
  });
  const updatedProgress = await ds.getUserProgress(userId, quiz.lessonId);
  const lessonCompleted = updatedProgress?.lessonCompleted ?? false;

  // 出席セッション記録（失敗しても進捗確定を優先し 200 を維持、logger.error で観測可能にする）
  let sessionRecorded = false;
  try {
    const activeSession = await ds.getActiveLessonSession(userId, quiz.lessonId);
    if (activeSession) {
      // TOCTOU 対策: 完了直前に状態を再確認（並行合格提出/force-exit/abandon との競合防止）
      const completed = await completeSessionAsQuizSkipped(ds, activeSession.id);
      sessionRecorded = completed !== null;
      if (completed === null) {
        logger.warn("Skip session completion skipped (session no longer active, concurrent event)", {
          eventType: "quiz_skip_session_no_longer_active",
          userId,
          lessonId: quiz.lessonId,
          sessionId: activeSession.id,
        });
      } else {
        logger.info("Quiz skip recorded via active session completion", {
          eventType: "quiz_skip_recorded",
          userId,
          lessonId: quiz.lessonId,
          courseId: quiz.courseId,
          sessionId: activeSession.id,
        });
      }
    } else {
      const video = await ds.getVideoByLessonId(quiz.lessonId);
      if (!video) {
        // 動画なしレッスン: スキップ自体は正常系（動画視聴が元々不要なため合成 session も不要）
        logger.info("Quiz skip recorded without session (lesson has no video)", {
          eventType: "quiz_skip_session_video_missing",
          userId,
          lessonId: quiz.lessonId,
          courseId: quiz.courseId,
        });
      } else {
        const { created } = await createSyntheticSkippedSession(ds, {
          userId,
          lessonId: quiz.lessonId,
          courseId: quiz.courseId,
          videoId: video.id,
          videoDurationSec: video.durationSec,
          skippedAt: new Date().toISOString(),
        });
        sessionRecorded = true;
        if (!created) {
          logger.info("Synthetic skip session already exists, skipping (idempotency hit)", {
            eventType: "quiz_skip_session_already_exists",
            userId,
            lessonId: quiz.lessonId,
          });
        } else {
          logger.info("Quiz skip recorded via synthetic session", {
            eventType: "quiz_skip_recorded",
            userId,
            lessonId: quiz.lessonId,
            courseId: quiz.courseId,
          });
        }
      }
    }
  } catch (err) {
    logger.error("Failed to record skip session", {
      eventType: "quiz_skip_session_failed",
      userId,
      lessonId: quiz.lessonId,
      courseId: quiz.courseId,
      error: err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : String(err),
    });
  }

  res.json({
    quizSkipped: true,
    lessonCompleted,
    sessionRecorded,
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

  // 受講期限チェック（#220） - 開始〜提出間の期限跨ぎに対応
  const submitBlocked = await guardQuizAccess(req, res);
  if (submitBlocked) return;

  const now = new Date();
  const answers: Record<string, string[]> = req.body.answers ?? {};

  // セッション制限チェック（出席管理）
  // テスト任意化 Stage 5(ケースD厳格化): QUIZ_REQUIRE_ACTIVE_SESSION=false の場合のみ、
  // セッション未作成（kind="none"）でもテスト提出を許可する後方互換経路が残る。
  // デフォルト（true）ではセッションなしの提出は下の else 節で拒否される。
  // resolveActiveSessionForQuiz は POST 側のゲートと共用する単一の意味論解決ポイント
  // （second opinion レビュー指摘反映: 以前は本ハンドラが同じ判定を独自実装していた）。
  const sessionState = await resolveActiveSessionForQuiz(ds, userId, quiz.lessonId);
  const activeSession = sessionState.kind === "active" ? sessionState.session : null;
  if (sessionState.kind === "expired") {
    try {
      await forceExitSession(ds, sessionState.session.id, "time_limit");
    } catch (err) {
      console.error(`Failed to force-exit session (time_limit): ${sessionState.session.id}`, err);
    }
    res.status(403).json({
      error: "session_time_exceeded",
      message: "セッション制限時間を超過したため、セッションが終了しました",
    });
    return;
  } else if (sessionState.kind === "none" && isQuizActiveSessionRequired()) {
    const video = await ds.getVideoByLessonId(quiz.lessonId);
    if (video) {
      // 移行期対応: Stage 5 デプロイ前に開始された in-flight attempt を採点前に
      // timed_out 化する（countEffectiveAttempts が timed_out を除外するため受験回数は消費しない）。
      await ds.transitionQuizAttemptToTimedOut(attemptId);
      res.status(409).json({
        error: "session_required",
        message: "動画を再生してレッスンセッションを開始してから受験してください",
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
  //
  // Issue #424 (Codex M2): `status !== "active"` を競合扱いに拡張。
  // 旧実装は `force_exited` のみを見ており、abandonSession と PATCH 提出が並行した場合に
  // `abandoned` セッションへの進捗更新が走ってしまうデータ整合性問題があった。
  // 後方互換: `force_exited` は既存 error code を維持、それ以外 (`abandoned` / `completed` 等) は
  // 新 error code `session_no_longer_active` で区別 (FE 側で動線分岐可能)。
  if (activeSession) {
    try {
      const currentSession = await ds.getLessonSession(activeSession.id);
      if (!currentSession || currentSession.status !== "active") {
        const sessionStatus = currentSession?.status ?? "not_found";
        const isForceExited = sessionStatus === "force_exited";
        res.status(409).json({
          error: isForceExited ? "session_force_exited" : "session_no_longer_active",
          message: isForceExited
            ? "セッションが強制終了されたため、進捗には反映されません。再受講が必要です。"
            : "セッションが終了しているため、進捗には反映されません。再受講が必要です。",
          sessionStatus,
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
    // Issue #424 (Codex Medium 88): completeSession 内で再 active 確認 → 非 active なら null。
    // null の場合は並行 abandon/forceExit があったため、ログのみ残して quiet pass する。
    if (activeSession) {
      try {
        const completed = await completeSession(ds, activeSession.id, updated!.id);
        if (completed === null) {
          console.warn(
            `completeSession skipped for attempt ${attemptId} (session no longer active, concurrent abandon/forceExit)`,
          );
        }
      } catch (err) {
        console.error(`Failed to complete session for attempt ${attemptId}:`, err);
      }
    } else if (quiz) {
      // Issue #533: active session なしで合格提出された場合、出席レポートに痕跡を残すため合成 session を作成する。
      // 進捗 (user_progress.quizPassed/quizBestScore) と出席 (lesson_sessions) の乖離を予防。
      // 失敗時は提出成功 (上で updateQuizAttempt 済み) を優先し、structured log で監視可能にする
      // (Issue #533 の根本問題は「乖離の検知手段がなかった」ことのため、ここで silent にしない)。
      //
      // テスト任意化 Stage 5(ケースD厳格化): QUIZ_REQUIRE_ACTIVE_SESSION=true（デフォルト）では
      // 動画ありレッスンでの activeSession=null 提出自体が上流の PATCH ゲートで拒否されるため、
      // この分岐は動画なしレッスン、または flag=false 時のみ到達する dead path になる。
      // Issue #533 の乖離再発防止のため意図的に温存（Stage 6 で削除・@deprecated 化を検討）。
      try {
        // 型ガード: 上位 updateQuizAttempt で submittedAt: now を渡しているため実行時には string が確定だが、
        // 型上 string|null のため defensive にチェック。null/undefined 時は throw して silent fail を防ぐ。
        if (!updated?.submittedAt) {
          throw new Error(`Quiz attempt ${attemptId} updated but submittedAt is missing`);
        }
        // attempt.startedAt も同様: 型上は string だが API/DB 不整合での null/undefined を防御。
        if (!attempt.startedAt) {
          throw new Error(`Quiz attempt ${attemptId} has missing startedAt`);
        }
        const video = await ds.getVideoByLessonId(quiz.lessonId);
        if (!video) {
          // hasVideo=true の lesson で video が消失/未登録のケースを区別可能にする。
          // hasVideo=false の lesson は INFO (運用上は別レッスン定義の問題)。
          logger.error("Synthetic session skipped: video not found for lesson", {
            eventType: "quiz_synthetic_session_video_missing",
            attemptId,
            lessonId: quiz.lessonId,
            courseId: quiz.courseId,
            userId,
          });
        } else {
          const { created } = await createSyntheticCompletedSession(ds, {
            userId,
            lessonId: quiz.lessonId,
            courseId: quiz.courseId,
            videoId: video.id,
            quizAttemptId: updated.id,
            startedAt: attempt.startedAt,
            submittedAt: updated.submittedAt,
            videoDurationSec: video.durationSec,
          });
          if (!created) {
            // 既存ヒット = 冪等性が機能した状態。retry / backfill 競合 / attemptId 衝突など複数原因あり得るため
            // 原因推定はせず info で記録する。
            logger.info("Synthetic session already exists, skipping (idempotency hit)", {
              eventType: "quiz_synthetic_session_already_exists",
              attemptId,
              lessonId: quiz.lessonId,
              userId,
            });
          }
        }
      } catch (err) {
        logger.error("Failed to create synthetic session", {
          eventType: "quiz_synthetic_session_failed",
          attemptId,
          lessonId: quiz.lessonId,
          courseId: quiz.courseId,
          userId,
          error: err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : String(err),
        });
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
