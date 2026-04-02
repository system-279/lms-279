"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { VideoPlayer } from "@/components/video/VideoPlayer";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";
import { SessionRulesNotice } from "@/components/session/SessionRulesNotice";
import { SessionTimer } from "@/components/session/SessionTimer";
import { PauseTimeoutOverlay } from "@/components/session/PauseTimeoutOverlay";
import { ForceExitDialog } from "@/components/session/ForceExitDialog";
import type { LessonSessionResponse } from "@lms-279/shared-types";
import { useVideoCompletion } from "@/lib/hooks/use-video-completion";

// ============================================================
// 型定義
// ============================================================

type Lesson = {
  id: string;
  courseId: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
  videoUnlocksPrior: boolean;
};

type Course = {
  id: string;
  name: string;
  description: string;
  status: string;
  passThreshold: number;
};

type VideoMeta = {
  id: string;
  lessonId: string;
  durationSec: number;
  requiredWatchRatio: number;
  speedLock: boolean;
};

type PlaybackData = {
  playbackUrl: string;
  video: {
    id: string;
    durationSec: number;
    requiredWatchRatio: number;
    speedLock: boolean;
  };
};


// ============================================================
// テスト関連の型定義
// ============================================================

type QuizOption = {
  id: string;
  text: string;
  isCorrect: boolean; // 受講者向けAPIでは常にfalse
};

type QuizQuestion = {
  id: string;
  text: string;
  type: "single" | "multi";
  options: QuizOption[];
  points: number;
};

type Quiz = {
  id: string;
  title: string;
  passThreshold: number;
  maxAttempts: number;
  timeLimitSec: number | null;
  questions: QuizQuestion[];
};

type AttemptSummary = {
  id: string;
  attemptNumber: number;
  status: "submitted" | "timed_out" | "in_progress";
  score: number | null;
  isPassed: boolean | null;
  startedAt: string;
  submittedAt: string | null;
};

type QuizByLessonResponse = {
  quiz: Quiz;
  userAttemptCount: number;
  attemptSummaries: AttemptSummary[];
};

type ActiveAttempt = {
  id: string;
  quizId: string;
  attemptNumber: number;
  status: string;
  startedAt: string;
  timeLimitSec: number | null;
};

type QuestionResult = {
  questionId: string;
  questionText: string;
  isCorrect: boolean;
  earnedPoints: number;
  maxPoints: number;
  correctOptionIds: string[];
  selectedOptionIds: string[];
  explanation: string;
};

type AttemptResult = {
  attempt: {
    id: string;
    quizId: string;
    attemptNumber: number;
    status: string;
    score: number | null;
    isPassed: boolean | null;
    startedAt: string;
    submittedAt: string | null;
  };
  quiz: { title: string };
  questionResults: QuestionResult[];
};

type LessonSession = LessonSessionResponse;

type ForceExitReason = "pause_timeout" | "time_limit";

type QuizUIState = "idle" | "taking" | "result";

// ============================================================
// テストセクションコンポーネント
// ============================================================

function QuizSection({
  lessonId,
  authFetch,
}: {
  lessonId: string;
  authFetch: <T>(url: string, options?: RequestInit) => Promise<T>;
}) {
  const [quizState, setQuizState] = useState<QuizUIState>("idle");
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [userAttemptCount, setUserAttemptCount] = useState(0);
  const [attemptSummaries, setAttemptSummaries] = useState<AttemptSummary[]>([]);
  const [activeAttempt, setActiveAttempt] = useState<ActiveAttempt | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [loadingQuiz, setLoadingQuiz] = useState(true);
  const [loadingStart, setLoadingStart] = useState(false);
  const [loadingSubmit, setLoadingSubmit] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  // テスト情報取得
  const fetchQuiz = useCallback(async () => {
    setLoadingQuiz(true);
    setQuizError(null);
    try {
      const data = await authFetch<QuizByLessonResponse>(
        `/api/v1/quizzes/by-lesson/${lessonId}`
      );
      setQuiz(data.quiz);
      setUserAttemptCount(data.userAttemptCount);
      setAttemptSummaries(data.attemptSummaries);
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : "テスト情報の取得に失敗しました");
    } finally {
      setLoadingQuiz(false);
    }
  }, [authFetch, lessonId]);

  useEffect(() => {
    fetchQuiz();
  }, [fetchQuiz]);

  // タイマー管理
  useEffect(() => {
    if (quizState !== "taking" || activeAttempt?.timeLimitSec == null) return;

    const startedAt = new Date(activeAttempt.startedAt).getTime();
    const deadlineMs = startedAt + activeAttempt.timeLimitSec * 1000;

    const tick = () => {
      const now = Date.now();
      const left = Math.max(0, Math.floor((deadlineMs - now) / 1000));
      setRemainingSec(left);
      if (left === 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        // 時間切れ: 自動提出
        handleSubmit(true);
      }
    };

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizState, activeAttempt]);

  // テスト開始
  const handleStart = async () => {
    if (!quiz) return;
    setLoadingStart(true);
    setQuizError(null);
    try {
      const data = await authFetch<{ attempt: ActiveAttempt }>(
        `/api/v1/quizzes/${quiz.id}/attempts`,
        { method: "POST" }
      );
      setActiveAttempt(data.attempt);
      setAnswers({});
      setResult(null);
      setQuizState("taking");
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : "テストの開始に失敗しました");
    } finally {
      setLoadingStart(false);
    }
  };

  // 回答選択（single: 1つのみ、multi: トグル）
  const handleOptionChange = (questionId: string, optionId: string, type: "single" | "multi") => {
    setAnswers((prev) => {
      if (type === "single") {
        return { ...prev, [questionId]: [optionId] };
      } else {
        const current = prev[questionId] ?? [];
        const exists = current.includes(optionId);
        return {
          ...prev,
          [questionId]: exists
            ? current.filter((id) => id !== optionId)
            : [...current, optionId],
        };
      }
    });
  };

  // 提出実行
  const handleSubmit = async (isAutoSubmit = false) => {
    if (!activeAttempt) return;
    if (!isAutoSubmit) setShowSubmitDialog(false);
    setLoadingSubmit(true);
    setQuizError(null);
    try {
      await authFetch<{ attempt: { id: string; status: string; score: number | null; isPassed: boolean | null } }>(
        `/api/v1/quiz-attempts/${activeAttempt.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: answersRef.current }),
        }
      );
      // 結果取得
      const resultData = await authFetch<AttemptResult>(
        `/api/v1/quiz-attempts/${activeAttempt.id}/result`
      );
      setResult(resultData);
      setQuizState("result");
      // 受験回数などを更新
      await fetchQuiz();
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : "テストの提出に失敗しました");
    } finally {
      setLoadingSubmit(false);
    }
  };

  // もう一度挑戦
  const handleRetry = () => {
    setQuizState("idle");
    setActiveAttempt(null);
    setAnswers({});
    setResult(null);
    setRemainingSec(null);
  };

  // タイマー表示フォーマット
  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  if (loadingQuiz) {
    return (
      <div className="rounded-md border p-6">
        <p className="text-sm text-muted-foreground">テストを読み込み中...</p>
      </div>
    );
  }

  if (quizError && quizState === "idle" && !quiz) {
    return (
      <div className="rounded-md border p-6">
        <p className="text-sm text-destructive">{quizError}</p>
      </div>
    );
  }

  if (!quiz) return null;

  const isUnlimited = quiz.maxAttempts === 0;
  const remainingAttempts = isUnlimited ? Infinity : quiz.maxAttempts - userAttemptCount;

  // ============================================================
  // 状態1: テスト未開始
  // ============================================================
  if (quizState === "idle") {
    return (
      <div className="rounded-md border p-6 space-y-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{quiz.title}</h2>
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span>合格基準: {quiz.passThreshold}%</span>
            {quiz.timeLimitSec != null && (
              <span>制限時間: {formatTime(quiz.timeLimitSec)}</span>
            )}
            {isUnlimited ? (
              <span>受験回数: 無制限</span>
            ) : (
              <span>残り受験回数: {remainingAttempts}/{quiz.maxAttempts}回</span>
            )}
          </div>
        </div>

        {quizError && (
          <p className="text-sm text-destructive">{quizError}</p>
        )}

        {remainingAttempts > 0 ? (
          <button
            onClick={handleStart}
            disabled={loadingStart}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loadingStart ? "開始中..." : "テストを開始"}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">
            受験可能な回数の上限に達しています。
          </p>
        )}

        {/* 過去の受験結果 */}
        {attemptSummaries.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">過去の受験結果</h3>
            <div className="divide-y rounded-md border">
              {attemptSummaries.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="text-muted-foreground">第{a.attemptNumber}回</span>
                  <div className="flex items-center gap-3">
                    {a.status === "timed_out" ? (
                      <Badge variant="outline" className="text-orange-600 border-orange-300">時間切れ</Badge>
                    ) : a.isPassed ? (
                      <Badge variant="default" className="bg-green-600 hover:bg-green-600 text-white">合格</Badge>
                    ) : (
                      <Badge variant="destructive">不合格</Badge>
                    )}
                    {a.score != null && <span className="font-medium">{a.score}%</span>}
                    {a.submittedAt && (
                      <span className="text-muted-foreground">
                        {new Date(a.submittedAt).toLocaleDateString("ja-JP")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ============================================================
  // 状態2: テスト受験中
  // ============================================================
  if (quizState === "taking") {
    const totalQuestions = quiz.questions.length;
    const answeredCount = Object.keys(answers).filter(
      (qId) => (answers[qId]?.length ?? 0) > 0
    ).length;

    return (
      <div className="rounded-md border space-y-0 overflow-hidden">
        {/* ヘッダー: タイトル + タイマー + 進捗 */}
        <div className="flex items-center justify-between px-6 py-4 bg-secondary/50 border-b">
          <div>
            <h2 className="text-base font-semibold">{quiz.title}</h2>
            <p className="text-xs text-muted-foreground">
              {answeredCount}/{totalQuestions} 問回答済み
            </p>
          </div>
          {remainingSec != null && (
            <div
              className={`text-lg font-mono font-bold ${
                remainingSec <= 60 ? "text-destructive" : "text-foreground"
              }`}
            >
              {formatTime(remainingSec)}
            </div>
          )}
        </div>

        {/* 問題一覧（全問スクロール） */}
        <div className="divide-y">
          {quiz.questions.map((q, idx) => (
            <div key={q.id} className="px-6 py-5 space-y-3">
              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-medium">
                  {idx + 1}
                </span>
                <p className="text-sm font-medium leading-relaxed">{q.text}</p>
              </div>
              {q.type === "multi" && (
                <p className="text-xs text-muted-foreground pl-9">複数選択可</p>
              )}
              <div className="space-y-2 pl-9">
                {q.options.map((opt) => {
                  const selected =
                    q.type === "single"
                      ? answers[q.id]?.[0] === opt.id
                      : (answers[q.id] ?? []).includes(opt.id);
                  return (
                    <label
                      key={opt.id}
                      className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-secondary/50"
                      }`}
                    >
                      <input
                        type={q.type === "single" ? "radio" : "checkbox"}
                        name={q.id}
                        value={opt.id}
                        checked={selected}
                        onChange={() => handleOptionChange(q.id, opt.id, q.type)}
                        className="accent-primary"
                      />
                      <span className="text-sm">{opt.text}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* フッター: エラー + 提出ボタン */}
        <div className="px-6 py-4 border-t bg-secondary/30 space-y-3">
          {quizError && (
            <p className="text-sm text-destructive">{quizError}</p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {answeredCount < totalQuestions && (
                <>{totalQuestions - answeredCount} 問未回答</>
              )}
            </span>
            <button
              onClick={() => setShowSubmitDialog(true)}
              disabled={loadingSubmit}
              className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loadingSubmit ? "提出中..." : "提出する"}
            </button>
          </div>
        </div>

        {/* 提出確認ダイアログ */}
        {showSubmitDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-background rounded-lg border shadow-lg p-6 w-full max-w-sm space-y-4 mx-4">
              <h3 className="text-base font-semibold">テストを提出しますか？</h3>
              {answeredCount < totalQuestions && (
                <p className="text-sm text-orange-600">
                  {totalQuestions - answeredCount} 問が未回答です。このまま提出しますか？
                </p>
              )}
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setShowSubmitDialog(false)}
                  className="rounded-md border px-4 py-2 text-sm hover:bg-secondary"
                >
                  キャンセル
                </button>
                <button
                  onClick={() => handleSubmit(false)}
                  disabled={loadingSubmit}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  提出する
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ============================================================
  // 状態3: 結果表示
  // ============================================================
  if (quizState === "result" && result) {
    const { attempt, questionResults } = result;
    const isTimedOut = attempt.status === "timed_out";
    const isPassed = attempt.isPassed;

    return (
      <div className="rounded-md border overflow-hidden space-y-0">
        {/* スコアヘッダー */}
        <div
          className={`px-6 py-6 text-center space-y-2 ${
            isTimedOut
              ? "bg-orange-50"
              : isPassed
              ? "bg-green-50"
              : "bg-red-50"
          }`}
        >
          <h2 className="text-lg font-semibold">{quiz.title}</h2>
          {isTimedOut ? (
            <Badge variant="outline" className="text-orange-600 border-orange-400 text-base px-3 py-1">
              時間切れ
            </Badge>
          ) : isPassed ? (
            <Badge className="bg-green-600 hover:bg-green-600 text-white text-base px-3 py-1">
              合格
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-base px-3 py-1">
              不合格
            </Badge>
          )}
          {attempt.score != null && (
            <p className="text-3xl font-bold">{attempt.score}%</p>
          )}
          <p className="text-sm text-muted-foreground">
            合格基準: {quiz.passThreshold}%
          </p>
        </div>

        {/* 各問題の正誤 */}
        <div className="divide-y">
          {questionResults.map((qr, idx) => (
            <div key={qr.questionId} className="px-6 py-5 space-y-3">
              <div className="flex items-start gap-3">
                <span
                  className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                    qr.isCorrect
                      ? "bg-green-100 text-green-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {idx + 1}
                </span>
                <div className="space-y-1 flex-1">
                  <p className="text-sm font-medium">{qr.questionText}</p>
                  <span
                    className={`text-xs font-medium ${
                      qr.isCorrect ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {qr.isCorrect ? "正解" : "不正解"}
                  </span>
                </div>
              </div>

              {/* 選択肢表示 */}
              {(() => {
                const question = quiz.questions.find((q) => q.id === qr.questionId);
                if (!question) return null;
                return (
                  <div className="space-y-2 pl-9">
                    {question.options.map((opt) => {
                      const isCorrectOpt = qr.correctOptionIds.includes(opt.id);
                      const isSelected = qr.selectedOptionIds.includes(opt.id);
                      return (
                        <div
                          key={opt.id}
                          className={`flex items-center gap-2 p-2 rounded-md text-sm ${
                            isCorrectOpt
                              ? "bg-green-50 border border-green-200 text-green-800"
                              : isSelected && !isCorrectOpt
                              ? "bg-red-50 border border-red-200 text-red-800"
                              : "text-muted-foreground"
                          }`}
                        >
                          <span className="text-xs font-mono">
                            {isCorrectOpt ? "✓" : isSelected ? "✗" : " "}
                          </span>
                          <span>{opt.text}</span>
                          {isCorrectOpt && (
                            <span className="ml-auto text-xs text-green-600">正解</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* 解説 */}
              {qr.explanation && (
                <div className="pl-9">
                  <p className="text-xs text-muted-foreground bg-secondary/50 rounded-md px-3 py-2">
                    <span className="font-medium">解説: </span>
                    {qr.explanation}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* フッター */}
        <div className="px-6 py-4 border-t bg-secondary/30 flex items-center justify-between">
          {quizError && (
            <p className="text-sm text-destructive">{quizError}</p>
          )}
          <div />
          {remainingAttempts > 0 ? (
            <button
              onClick={handleRetry}
              className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-secondary"
            >
              もう一度挑戦{isUnlimited ? "" : ` (残り${remainingAttempts}回)`}
            </button>
          ) : (
            <span className="text-sm text-muted-foreground">
              受験可能回数の上限に達しました
            </span>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ============================================================
// ページコンポーネント
// ============================================================

export default function StudentLessonDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const lessonId = params.lessonId as string;
  const { tenantId } = useTenant();
  const { authFetch, authLoading } = useAuthenticatedFetch();

  /**
   * VideoEventTracker の fetchFn シグネチャ (url, options?) => Promise<Response> に合わせるラッパー。
   * authFetch は JSON をパースして T を返すため、イベント送信専用に Response 互換オブジェクトを返す。
   */
  const eventFetchFn = useCallback(
    async (url: string, options?: RequestInit): Promise<Response> => {
      const data = await authFetch<unknown>(url, options);
      // POST /eventsのレスポンス（analytics含む）をVideoEventTrackerに渡す
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    [authFetch]
  );

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [currentLesson, setCurrentLesson] = useState<Lesson | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  // 動画完了判定（カスタムフック）
  const {
    analytics,
    loadingAnalytics,
    showQuizSection,
    handleVideoComplete,
    setAnalyticsFromFlush,
  } = useVideoCompletion({
    authFetch,
    videoMeta,
    hasVideo: currentLesson?.hasVideo ?? false,
    hasQuiz: currentLesson?.hasQuiz ?? false,
  });

  // セッション（入退室管理）
  const [session, setSession] = useState<LessonSession | null>(null);
  const [videoPaused, setVideoPaused] = useState(false);
  const [forceExitOpen, setForceExitOpen] = useState(false);
  const [forceExitReason, setForceExitReason] = useState<ForceExitReason>("time_limit");
  const sessionCreatingRef = useRef(false);
  // セッション作成前からVideoPlayerに渡すtoken。createSessionで同じ値をBEに送信する。
  const pendingTokenRef = useRef(crypto.randomUUID());

  const [loadingCourse, setLoadingCourse] = useState(true);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  // ============================================================
  // コース・レッスン一覧取得
  // ============================================================

  const fetchCourse = useCallback(async () => {
    setLoadingCourse(true);
    setError(null);
    try {
      const data = await authFetch<{ course: Course; lessons: Lesson[] }>(
        `/api/v1/courses/${courseId}`
      );
      setCourse(data.course);
      const sorted = [...data.lessons].sort((a, b) => a.order - b.order);
      setLessons(sorted);
      const found = sorted.find((l) => l.id === lessonId) ?? null;
      setCurrentLesson(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : "講座情報の取得に失敗しました");
    } finally {
      setLoadingCourse(false);
    }
  }, [authFetch, courseId, lessonId]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse]);

  // ============================================================
  // セッション（入退室管理）
  // ============================================================

  // ページ読み込み時: アクティブセッション取得
  const fetchActiveSession = useCallback(async () => {
    try {
      const data = await authFetch<{ session: LessonSession | null }>(
        `/api/v1/lesson-sessions/active?lessonId=${lessonId}`
      );
      if (data.session) {
        setSession(data.session);
      }
    } catch (error) {
      console.error("Failed to fetch active session:", error);
    }
  }, [authFetch, lessonId]);

  useEffect(() => {
    if (authLoading) return;
    fetchActiveSession();
  }, [fetchActiveSession, authLoading]);

  // 動画初回再生時: セッション作成
  // pendingTokenRefと同じtokenをBEに送信し、VideoPlayerが送るイベントと一致させる
  const createSession = useCallback(async () => {
    if (session || sessionCreatingRef.current || !videoMeta) return;
    sessionCreatingRef.current = true;
    try {
      const data = await authFetch<{ session: LessonSession }>(
        `/api/v1/lesson-sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lessonId,
            videoId: videoMeta.id,
            sessionToken: pendingTokenRef.current,
          }),
        }
      );
      setSession(data.session);
    } catch (error) {
      console.error("Failed to create session:", error);
      setError("出席セッションの作成に失敗しました。ページを再読み込みしてください。");
    } finally {
      sessionCreatingRef.current = false;
    }
  }, [authFetch, lessonId, videoMeta, session]);

  // 強制退室処理
  const handleForceExit = useCallback(
    async (reason: ForceExitReason) => {
      if (!session) return;
      try {
        await authFetch<unknown>(
          `/api/v1/lesson-sessions/${session.id}/force-exit`,
          { method: "PATCH", body: JSON.stringify({ reason }) }
        );
      } catch (error) {
        console.error("Failed to force-exit session:", error);
      }
      setForceExitReason(reason);
      setForceExitOpen(true);
    },
    [authFetch, session]
  );

  // タイマー期限切れ
  const handleSessionExpired = useCallback(() => {
    handleForceExit("time_limit");
  }, [handleForceExit]);

  // 一時停止タイムアウト
  const handlePauseTimeout = useCallback(() => {
    handleForceExit("pause_timeout");
  }, [handleForceExit]);

  // ブラウザ終了時: sendBeaconでセッション放棄
  // fetch()はbeforeunloadで中断されるためsendBeaconを使用。
  // sendBeaconはカスタムヘッダーを送れないため、authFetchを使わず/api/v2パスに直接リクエスト。
  // visibilitychangeは使わない: タブ切替やアプリ切替でもhiddenが発火し、
  // 正常な学習中のセッションがabandonedになる誤判定を引き起こすため。
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!session || session.status !== "active") return;
      const url = `/api/v2/${tenantId}/lesson-sessions/${session.id}/abandon`;
      navigator.sendBeacon(url);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [session, tenantId]);

  // ============================================================
  // 動画メタデータ・再生URL取得
  // ============================================================

  const fetchVideoData = useCallback(async () => {
    if (!currentLesson?.hasVideo) return;
    setLoadingVideo(true);
    setVideoError(null);
    try {
      // 1. レッスンに紐づく動画IDを取得
      const metaData = await authFetch<{ video: VideoMeta }>(
        `/api/v1/lessons/${lessonId}/video`
      );
      setVideoMeta(metaData.video);

      // 2. 署名付き再生URLを取得
      const playbackData = await authFetch<PlaybackData>(
        `/api/v1/videos/${metaData.video.id}/playback-url`
      );
      setPlaybackUrl(playbackData.playbackUrl);
    } catch (e) {
      setVideoError(e instanceof Error ? e.message : "動画情報の取得に失敗しました");
    } finally {
      setLoadingVideo(false);
    }
  }, [authFetch, currentLesson, lessonId]);

  useEffect(() => {
    if (currentLesson) {
      fetchVideoData();
    }
  }, [currentLesson, fetchVideoData]);

  // ============================================================
  // 視聴分析取得
  // ============================================================

  // 動画再生開始: セッション作成
  const handleVideoPlay = useCallback(() => {
    setVideoPaused(false);
    createSession();
  }, [createSession]);

  // 動画一時停止
  const handleVideoPause = useCallback(() => {
    setVideoPaused(true);
  }, []);

  // ============================================================
  // ナビゲーション（前後レッスン）
  // ============================================================

  const currentIndex = lessons.findIndex((l) => l.id === lessonId);
  const prevLesson = currentIndex > 0 ? lessons[currentIndex - 1] : null;
  const nextLesson = currentIndex >= 0 && currentIndex < lessons.length - 1
    ? lessons[currentIndex + 1]
    : null;

  // ============================================================
  // 視聴進捗
  // ============================================================

  const coveragePercent = analytics
    ? Math.round(analytics.coverageRatio * 100)
    : 0;

  // ============================================================
  // レンダリング
  // ============================================================

  if (loadingCourse) {
    return (
      <div className="space-y-6">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
        <Link
          href={`/${tenantId}/student/courses/${courseId}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← コースに戻る
        </Link>
      </div>
    );
  }

  if (!currentLesson) {
    return (
      <div className="space-y-6">
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          レッスンが見つかりません
        </div>
        <Link
          href={`/${tenantId}/student/courses/${courseId}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← コースに戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* セッションタイマー（セッション有効時のみ） */}
      {session && (
        <SessionTimer
          deadlineAt={session.deadlineAt}
          onExpired={handleSessionExpired}
        />
      )}

      {/* パンくずリスト */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href={`/${tenantId}/student/courses`}
          className="hover:text-foreground"
        >
          講座一覧
        </Link>
        <span>/</span>
        <Link
          href={`/${tenantId}/student/courses/${courseId}`}
          className="hover:text-foreground"
        >
          {course?.name ?? "..."}
        </Link>
        <span>/</span>
        <span className="text-foreground">{currentLesson.title}</span>
      </div>

      {/* レッスンタイトル */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{currentLesson.title}</h1>
      </div>

      {/* 受講ルール */}
      <SessionRulesNotice session={session} />

      {/* 動画セクション */}
      <div className="space-y-4">
        {currentLesson.hasVideo ? (
          <>
            {loadingVideo && (
              <div className="w-full aspect-video bg-black/5 rounded-lg flex items-center justify-center text-muted-foreground">
                動画を読み込み中...
              </div>
            )}

            {videoError && (
              <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
                {videoError}
              </div>
            )}

            {!loadingVideo && !videoError && playbackUrl && videoMeta && (
              <>
                <div className="relative">
                  <VideoPlayer
                    videoId={videoMeta.id}
                    src={playbackUrl}
                    speedLock={videoMeta.speedLock}
                    eventEndpoint={`/api/v2/${tenantId}/videos/${videoMeta.id}/events`}
                    fetchFn={eventFetchFn}
                    onComplete={handleVideoComplete}
                    onEndedFlush={setAnalyticsFromFlush}
                    onPlay={handleVideoPlay}
                    onPause={handleVideoPause}
                    sessionToken={session?.sessionToken ?? pendingTokenRef.current}
                  />
                  {session && (
                    <PauseTimeoutOverlay
                      isPaused={videoPaused && !showQuizSection}
                      onTimeout={handlePauseTimeout}
                    />
                  )}
                </div>

                {/* 視聴進捗 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">視聴進捗</span>
                    <div className="flex items-center gap-2">
                      {analytics?.isComplete && (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-600 text-white">
                          視聴完了
                        </Badge>
                      )}
                      {!loadingAnalytics && (
                        <span className="font-medium">{coveragePercent}%</span>
                      )}
                    </div>
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-primary h-2 rounded-full transition-all duration-500"
                      style={{ width: `${coveragePercent}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="rounded-md border p-8 text-center text-muted-foreground">
            このレッスンには動画がありません
          </div>
        )}
      </div>

      {/* テストセクション */}
      {currentLesson.hasQuiz && (
        showQuizSection ? (
          <QuizSection lessonId={lessonId} authFetch={authFetch} />
        ) : (
          /* 動画未完了ゲートメッセージ */
          <div className="rounded-md border p-6 space-y-3">
            <p className="text-sm font-medium text-center">テストに挑戦する</p>
            <p className="text-sm text-muted-foreground text-center">
              動画を最後まで視聴するとテストに挑戦できます
            </p>
            <div className="rounded bg-destructive/10 px-3 py-2">
              <p className="text-xs font-medium text-destructive text-center">
                飛ばした部分は視聴としてカウントされません。最初から通して視聴してください。
              </p>
            </div>
          </div>
        )
      )}

      {/* ナビゲーション */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div>
          {prevLesson ? (
            <Link
              href={`/${tenantId}/student/courses/${courseId}/lessons/${prevLesson.id}`}
              className="flex flex-col gap-0.5 text-sm hover:text-foreground text-muted-foreground"
            >
              <span className="text-xs">前のレッスン</span>
              <span className="font-medium">← {prevLesson.title}</span>
            </Link>
          ) : (
            <Link
              href={`/${tenantId}/student/courses/${courseId}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← コースに戻る
            </Link>
          )}
        </div>

        <div className="text-right">
          {nextLesson && (
            <Link
              href={`/${tenantId}/student/courses/${courseId}/lessons/${nextLesson.id}`}
              className="flex flex-col gap-0.5 text-sm hover:text-foreground text-muted-foreground items-end"
            >
              <span className="text-xs">次のレッスン</span>
              <span className="font-medium">{nextLesson.title} →</span>
            </Link>
          )}
        </div>
      </div>

      {/* 強制退室ダイアログ */}
      <ForceExitDialog open={forceExitOpen} reason={forceExitReason} />
    </div>
  );
}
