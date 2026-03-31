"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VideoPlayer } from "@/components/video/VideoPlayer";
import { useSuperAdminFetch } from "@/lib/super-api";

// --- Types ---

type Lesson = {
  id: string;
  courseId: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
};

type VideoMeta = {
  id: string;
  durationSec: number;
  requiredWatchRatio: number;
  speedLock: boolean;
};

type QuestionOption = {
  id: string;
  text: string;
  isCorrect: boolean;
};

type Question = {
  id: string;
  text: string;
  type: "single" | "multi";
  options: QuestionOption[];
  points: number;
  explanation: string;
};

type Quiz = {
  id: string;
  title: string;
  passThreshold: number;
  maxAttempts: number;
  timeLimitSec: number | null;
  questions: Question[];
};

type QuizUIState = "idle" | "taking" | "result";

type GradeResult = {
  score: number;
  maxScore: number;
  percent: number;
  passed: boolean;
  details: {
    questionId: string;
    isCorrect: boolean;
    correctOptionIds: string[];
    selectedOptionIds: string[];
  }[];
};

// --- Component ---

export default function LessonPreviewPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const lessonId = params.lessonId as string;
  const { superFetch } = useSuperAdminFetch();

  // Lesson data
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Video
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [videoCompleted, setVideoCompleted] = useState(false);

  // Quiz
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [quizState, setQuizState] = useState<QuizUIState>("idle");
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [gradeResult, setGradeResult] = useState<GradeResult | null>(null);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  // Course name for breadcrumb
  const [courseName, setCourseName] = useState<string>("");

  // Fetch lesson data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch lesson + course info in parallel
      const [lessonData, courseData] = await Promise.all([
        superFetch<{ lesson: Lesson }>(`/api/v2/super/master/lessons/${lessonId}`),
        superFetch<{ course: { name: string } }>(`/api/v2/super/master/courses/${courseId}`),
      ]);
      setLesson(lessonData.lesson);
      setCourseName(courseData.course.name);

      // Fetch video if exists
      if (lessonData.lesson.hasVideo) {
        const videos = await superFetch<{ videos: { id: string; lessonId: string }[] }>(
          `/api/v2/super/master/courses/${courseId}`,
        );
        const video = (videos as unknown as { videos: { id: string; lessonId: string }[] }).videos?.find(
          (v) => v.lessonId === lessonId,
        );
        if (video) {
          const urlData = await superFetch<{ playbackUrl: string; video: VideoMeta }>(
            `/api/v2/super/master/videos/${video.id}/playback-url`,
          );
          setVideoMeta(urlData.video);
          setPlaybackUrl(urlData.playbackUrl);
        }
      }

      // Fetch quiz if exists
      if (lessonData.lesson.hasQuiz) {
        const courseFullData = await superFetch<{ quizzes: { id: string; lessonId: string }[] }>(
          `/api/v2/super/master/courses/${courseId}`,
        );
        const quizSummary = (courseFullData as unknown as { quizzes: { id: string; lessonId: string }[] }).quizzes?.find(
          (q) => q.lessonId === lessonId,
        );
        if (quizSummary) {
          const quizData = await superFetch<{ quiz: Quiz }>(
            `/api/v2/super/master/quizzes/${quizSummary.id}`,
          );
          setQuiz(quizData.quiz);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [superFetch, courseId, lessonId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Timer for quiz
  useEffect(() => {
    if (quizState !== "taking" || !quiz?.timeLimitSec || remainingSec === null) return;
    timerRef.current = setInterval(() => {
      setRemainingSec((prev) => {
        if (prev === null || prev <= 1) {
          handleGrade(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizState, quiz?.timeLimitSec]);

  // Quiz handlers
  const handleStartQuiz = () => {
    setAnswers({});
    setGradeResult(null);
    setQuizState("taking");
    if (quiz?.timeLimitSec) {
      setRemainingSec(quiz.timeLimitSec);
    }
  };

  const handleAnswer = (questionId: string, optionId: string, type: "single" | "multi") => {
    setAnswers((prev) => {
      if (type === "single") {
        return { ...prev, [questionId]: [optionId] };
      }
      const current = prev[questionId] ?? [];
      const selected = current.includes(optionId);
      return {
        ...prev,
        [questionId]: selected
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      };
    });
  };

  const handleGrade = (timedOut = false) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!quiz) return;

    const currentAnswers = answersRef.current;
    let score = 0;
    let maxScore = 0;
    const details = quiz.questions.map((q) => {
      const correctIds = q.options.filter((o) => o.isCorrect).map((o) => o.id).sort();
      const selectedIds = (currentAnswers[q.id] ?? []).sort();
      const isCorrect = !timedOut && correctIds.length === selectedIds.length && correctIds.every((id, i) => id === selectedIds[i]);
      maxScore += q.points;
      if (isCorrect) score += q.points;
      return { questionId: q.id, isCorrect, correctOptionIds: correctIds, selectedOptionIds: selectedIds };
    });
    const percent = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
    setGradeResult({ score, maxScore, percent, passed: percent >= quiz.passThreshold, details });
    setQuizState("result");
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const answeredCount = Object.keys(answers).filter((k) => (answers[k]?.length ?? 0) > 0).length;

  // Show quiz section if no video or video completed
  const showQuiz = lesson?.hasQuiz && (!lesson.hasVideo || videoCompleted);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (error || !lesson) {
    return (
      <div className="space-y-4">
        <div className="text-destructive">{error ?? "レッスンが見つかりません"}</div>
        <Link href={`/super/master/courses/${courseId}`} className="text-sm text-blue-600 hover:underline">
          コース管理に戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Preview mode banner */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge className="bg-yellow-100 text-yellow-800 border-yellow-300">プレビューモード</Badge>
          <span className="text-sm text-yellow-800">受講者が見る画面と同等のプレビューです。データは保存されません。</span>
        </div>
        <Link
          href={`/super/master/courses/${courseId}`}
          className="text-sm text-yellow-800 hover:underline font-medium"
        >
          管理画面に戻る
        </Link>
      </div>

      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground">
        <Link href="/super/master/courses" className="hover:underline">マスターコース</Link>
        {" / "}
        <Link href={`/super/master/courses/${courseId}`} className="hover:underline">{courseName}</Link>
        {" / "}
        <span className="text-foreground">{lesson.title}</span>
      </nav>

      {/* Lesson title */}
      <h1 className="text-2xl font-bold">{lesson.title}</h1>

      {/* Video section */}
      {lesson.hasVideo && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">動画</h2>
          {playbackUrl ? (
            <div className="space-y-3">
              <VideoPlayer
                src={playbackUrl}
                preview
                speedLock={videoMeta?.speedLock ?? true}
                onComplete={() => setVideoCompleted(true)}
              />
              {videoMeta && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {Math.floor(videoMeta.durationSec / 60)}分{videoMeta.durationSec % 60}秒
                    {videoMeta.speedLock && " / 倍速禁止"}
                  </span>
                  <div className="flex items-center gap-2">
                    {videoCompleted ? (
                      <Badge className="bg-green-100 text-green-800 border-green-200">視聴完了</Badge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setVideoCompleted(true)}
                      >
                        視聴完了にする（プレビュー用）
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border p-8 text-center text-muted-foreground">
              動画が設定されていません
            </div>
          )}
        </div>
      )}

      {/* Video gate message */}
      {lesson.hasQuiz && lesson.hasVideo && !videoCompleted && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
          動画の視聴を完了するとテストが表示されます。
        </div>
      )}

      {/* Quiz section */}
      {showQuiz && quiz && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">テスト</h2>

          {/* idle state */}
          {quizState === "idle" && (
            <div className="border rounded-lg p-6 space-y-4">
              <h3 className="font-medium">{quiz.title}</h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">問題数: </span>
                  <span className="font-medium">{quiz.questions.length}問</span>
                </div>
                <div>
                  <span className="text-muted-foreground">合格基準: </span>
                  <span className="font-medium">{quiz.passThreshold}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">最大受験回数: </span>
                  <span className="font-medium">{quiz.maxAttempts === 0 ? "無制限" : `${quiz.maxAttempts}回`}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">制限時間: </span>
                  <span className="font-medium">
                    {quiz.timeLimitSec ? `${Math.floor(quiz.timeLimitSec / 60)}分` : "なし"}
                  </span>
                </div>
              </div>
              <Button onClick={handleStartQuiz}>テストを開始</Button>
            </div>
          )}

          {/* taking state */}
          {quizState === "taking" && (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between border-b pb-3">
                <div className="text-sm text-muted-foreground">
                  回答済み: {answeredCount} / {quiz.questions.length}問
                </div>
                {remainingSec !== null && (
                  <div className={`text-sm font-mono font-bold ${remainingSec < 60 ? "text-red-600" : ""}`}>
                    残り {formatTime(remainingSec)}
                  </div>
                )}
              </div>

              {/* Questions */}
              {quiz.questions.map((q, qIdx) => (
                <div key={q.id} className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <span className="text-sm font-bold bg-muted rounded-full w-7 h-7 flex items-center justify-center shrink-0">
                      {qIdx + 1}
                    </span>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{q.text}</p>
                      {q.type === "multi" && (
                        <p className="text-xs text-muted-foreground">複数選択可</p>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 ml-9">
                    {q.options.map((opt) => {
                      const selected = answers[q.id]?.includes(opt.id) ?? false;
                      return (
                        <label
                          key={opt.id}
                          className={`flex items-center gap-3 p-2 rounded-md border cursor-pointer transition-colors ${selected ? "bg-blue-50 border-blue-300" : "hover:bg-muted/50"}`}
                        >
                          <input
                            type={q.type === "single" ? "radio" : "checkbox"}
                            name={`q-${q.id}`}
                            checked={selected}
                            onChange={() => handleAnswer(q.id, opt.id, q.type)}
                            className="shrink-0"
                          />
                          <span className="text-sm">{opt.text}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Submit */}
              <div className="flex items-center justify-between pt-2 border-t">
                {answeredCount < quiz.questions.length && (
                  <p className="text-sm text-yellow-600">
                    未回答: {quiz.questions.length - answeredCount}問
                  </p>
                )}
                <div className="flex gap-2 ml-auto">
                  <Button variant="outline" onClick={() => { setQuizState("idle"); setAnswers({}); }}>
                    キャンセル
                  </Button>
                  <Button onClick={() => handleGrade()}>
                    提出する
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* result state */}
          {quizState === "result" && gradeResult && (
            <div className="space-y-4">
              {/* Score header */}
              <div className={`text-center p-6 rounded-lg ${gradeResult.passed ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                <p className="text-3xl font-bold">{gradeResult.percent}%</p>
                <p className="text-sm text-muted-foreground mt-1">{gradeResult.score} / {gradeResult.maxScore} 点</p>
                <Badge className={`mt-2 ${gradeResult.passed ? "bg-green-100 text-green-800 border-green-300" : "bg-red-100 text-red-800 border-red-300"}`}>
                  {gradeResult.passed ? "合格" : "不合格"}
                </Badge>
              </div>

              {/* Question results */}
              {quiz.questions.map((q, qIdx) => {
                const detail = gradeResult.details.find((d) => d.questionId === q.id);
                if (!detail) return null;
                return (
                  <div key={q.id} className={`border rounded-lg p-4 space-y-2 ${detail.isCorrect ? "border-green-200 bg-green-50/50" : "border-red-200 bg-red-50/50"}`}>
                    <div className="flex items-start gap-2">
                      <span className={`text-sm font-bold rounded-full w-7 h-7 flex items-center justify-center shrink-0 ${detail.isCorrect ? "bg-green-200 text-green-800" : "bg-red-200 text-red-800"}`}>
                        {detail.isCorrect ? "○" : "×"}
                      </span>
                      <p className="text-sm font-medium">問{qIdx + 1}. {q.text}</p>
                    </div>
                    <div className="space-y-1 ml-9">
                      {q.options.map((opt) => {
                        const isCorrect = detail.correctOptionIds.includes(opt.id);
                        const isSelected = detail.selectedOptionIds.includes(opt.id);
                        return (
                          <div
                            key={opt.id}
                            className={`text-sm p-1.5 rounded ${isCorrect && isSelected ? "text-green-800 font-medium" : isCorrect ? "text-green-700" : isSelected ? "text-red-700 line-through" : "text-muted-foreground"}`}
                          >
                            {isCorrect ? "✓ " : isSelected ? "✗ " : "  "}
                            {opt.text}
                            {isCorrect && !isSelected && " (正解)"}
                          </div>
                        );
                      })}
                      {q.explanation && (
                        <p className="text-xs text-muted-foreground mt-2 p-2 bg-muted rounded">
                          解説: {q.explanation}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Footer */}
              <div className="flex gap-2 pt-2 border-t">
                <Button variant="outline" onClick={() => { setQuizState("idle"); setAnswers({}); setGradeResult(null); }}>
                  もう一度
                </Button>
                <Link href={`/super/master/courses/${courseId}`}>
                  <Button variant="outline">コース管理に戻る</Button>
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {/* No quiz message */}
      {!lesson.hasQuiz && !lesson.hasVideo && (
        <div className="rounded-lg border p-8 text-center text-muted-foreground">
          このレッスンにはコンテンツが設定されていません。
        </div>
      )}

      {/* Navigation */}
      <div className="pt-4 border-t">
        <Link
          href={`/super/master/courses/${courseId}`}
          className="text-sm text-blue-600 hover:underline"
        >
          ← コース管理に戻る
        </Link>
      </div>
    </div>
  );
}
