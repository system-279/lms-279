"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";

// ─── Types ────────────────────────────────────────────────────────────────────

type Lesson = {
  id: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
};

type VideoInfo = {
  id: string;
  gcsPath: string;
  durationSec: number | null;
  requiredWatchRatio: number;
  speedLock: boolean;
  playbackUrl?: string;
};

type LessonDetail = {
  lesson: Lesson;
  video: VideoInfo | null;
};

type QuizChoice = {
  id: string;
  text: string;
  isCorrect: boolean;
};

type QuizQuestion = {
  id: string;
  text: string;
  type: "single" | "multi";
  points: number;
  explanation: string;
  choices: QuizChoice[];
};

type Quiz = {
  id: string;
  title: string;
  passingScore: number;
  maxAttempts: number;
  timeLimitSec: number | null;
  requireVideoCompletion: boolean;
  shuffleQuestions: boolean;
  shuffleChoices: boolean;
  questions: QuizQuestion[];
};

// ─── Default factories ────────────────────────────────────────────────────────

function newChoice(): QuizChoice {
  return { id: crypto.randomUUID(), text: "", isCorrect: false };
}

function newQuestion(): QuizQuestion {
  return {
    id: crypto.randomUUID(),
    text: "",
    type: "single",
    points: 1,
    explanation: "",
    choices: [newChoice(), newChoice()],
  };
}

const defaultQuizForm = {
  title: "",
  passingScore: 70,
  maxAttempts: 3,
  timeLimitSec: "" as string, // empty = unlimited
  requireVideoCompletion: true,
  shuffleQuestions: false,
  shuffleChoices: false,
};

// ─── QuizSection component ────────────────────────────────────────────────────

function QuizSection({ lessonId }: { lessonId: string }) {
  const { authFetch } = useAuthenticatedFetch();

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [quizLoading, setQuizLoading] = useState(true);
  const [quizError, setQuizError] = useState<string | null>(null);

  // Create/edit quiz dialog
  const [quizDialogOpen, setQuizDialogOpen] = useState(false);
  const [isEditingQuiz, setIsEditingQuiz] = useState(false);
  const [quizForm, setQuizForm] = useState({ ...defaultQuizForm });
  const [quizSaving, setQuizSaving] = useState(false);
  const [quizSaveError, setQuizSaveError] = useState<string | null>(null);

  // Delete quiz
  const [deleteQuizLoading, setDeleteQuizLoading] = useState(false);
  const [deleteQuizError, setDeleteQuizError] = useState<string | null>(null);

  // Question dialog
  const [questionDialogOpen, setQuestionDialogOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<QuizQuestion | null>(null);
  const [questionForm, setQuestionForm] = useState<QuizQuestion>(newQuestion());
  const [questionSaving, setQuestionSaving] = useState(false);
  const [questionSaveError, setQuestionSaveError] = useState<string | null>(null);

  // ── Fetch quiz ────────────────────────────────────────────────────────────

  const fetchQuiz = useCallback(async () => {
    setQuizLoading(true);
    setQuizError(null);
    try {
      const data = await authFetch<Quiz>(
        `/api/v1/admin/lessons/${lessonId}/quiz`
      );
      setQuiz(data);
    } catch (e: unknown) {
      // 404 means no quiz yet — not an error
      if (e instanceof Error && e.message.includes("404")) {
        setQuiz(null);
      } else {
        setQuizError(e instanceof Error ? e.message : "テストの取得に失敗しました");
      }
    } finally {
      setQuizLoading(false);
    }
  }, [authFetch, lessonId]);

  useEffect(() => {
    fetchQuiz();
  }, [fetchQuiz]);

  // ── Quiz create/edit dialog helpers ──────────────────────────────────────

  const openCreateQuizDialog = () => {
    setIsEditingQuiz(false);
    setQuizForm({ ...defaultQuizForm });
    setQuizSaveError(null);
    setQuizDialogOpen(true);
  };

  const openEditQuizDialog = () => {
    if (!quiz) return;
    setIsEditingQuiz(true);
    setQuizForm({
      title: quiz.title,
      passingScore: quiz.passingScore,
      maxAttempts: quiz.maxAttempts,
      timeLimitSec: quiz.timeLimitSec != null ? String(quiz.timeLimitSec) : "",
      requireVideoCompletion: quiz.requireVideoCompletion,
      shuffleQuestions: quiz.shuffleQuestions,
      shuffleChoices: quiz.shuffleChoices,
    });
    setQuizSaveError(null);
    setQuizDialogOpen(true);
  };

  const handleSaveQuiz = async () => {
    setQuizSaving(true);
    setQuizSaveError(null);
    try {
      const payload = {
        title: quizForm.title,
        passingScore: Number(quizForm.passingScore),
        maxAttempts: Number(quizForm.maxAttempts),
        timeLimitSec:
          quizForm.timeLimitSec === "" ? null : Number(quizForm.timeLimitSec),
        requireVideoCompletion: quizForm.requireVideoCompletion,
        shuffleQuestions: quizForm.shuffleQuestions,
        shuffleChoices: quizForm.shuffleChoices,
      };

      if (isEditingQuiz) {
        const updated = await authFetch<Quiz>(
          `/api/v1/admin/lessons/${lessonId}/quiz`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, questions: quiz?.questions ?? [] }),
          }
        );
        setQuiz(updated);
      } else {
        const created = await authFetch<Quiz>(
          `/api/v1/admin/lessons/${lessonId}/quiz`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, questions: [] }),
          }
        );
        setQuiz(created);
      }
      setQuizDialogOpen(false);
    } catch (e) {
      setQuizSaveError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setQuizSaving(false);
    }
  };

  // ── Delete quiz ───────────────────────────────────────────────────────────

  const handleDeleteQuiz = async () => {
    if (!confirm("テストを削除しますか？この操作は取り消せません。")) return;
    setDeleteQuizLoading(true);
    setDeleteQuizError(null);
    try {
      await authFetch(`/api/v1/admin/lessons/${lessonId}/quiz`, {
        method: "DELETE",
      });
      setQuiz(null);
    } catch (e) {
      setDeleteQuizError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteQuizLoading(false);
    }
  };

  // ── Question dialog helpers ───────────────────────────────────────────────

  const openAddQuestionDialog = () => {
    setEditingQuestion(null);
    setQuestionForm(newQuestion());
    setQuestionSaveError(null);
    setQuestionDialogOpen(true);
  };

  const openEditQuestionDialog = (q: QuizQuestion) => {
    setEditingQuestion(q);
    setQuestionForm({ ...q, choices: q.choices.map((c) => ({ ...c })) });
    setQuestionSaveError(null);
    setQuestionDialogOpen(true);
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!quiz) return;
    if (!confirm("この問題を削除しますか？")) return;
    const updated = quiz.questions.filter((q) => q.id !== questionId);
    try {
      const saved = await authFetch<Quiz>(
        `/api/v1/admin/lessons/${lessonId}/quiz`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questions: updated }),
        }
      );
      setQuiz(saved);
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  const handleSaveQuestion = async () => {
    setQuestionSaving(true);
    setQuestionSaveError(null);
    try {
      if (!quiz) return;
      let updatedQuestions: QuizQuestion[];
      if (editingQuestion) {
        updatedQuestions = quiz.questions.map((q) =>
          q.id === editingQuestion.id ? { ...questionForm } : q
        );
      } else {
        updatedQuestions = [...quiz.questions, { ...questionForm }];
      }
      const saved = await authFetch<Quiz>(
        `/api/v1/admin/lessons/${lessonId}/quiz`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questions: updatedQuestions }),
        }
      );
      setQuiz(saved);
      setQuestionDialogOpen(false);
    } catch (e) {
      setQuestionSaveError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setQuestionSaving(false);
    }
  };

  // ── Question form helpers ─────────────────────────────────────────────────

  const updateQuestionField = <K extends keyof QuizQuestion>(
    key: K,
    value: QuizQuestion[K]
  ) => {
    setQuestionForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleQuestionTypeChange = (type: "single" | "multi") => {
    setQuestionForm((prev) => {
      let choices = prev.choices;
      // If switching to single, ensure at most one choice is marked correct
      if (type === "single") {
        let foundFirst = false;
        choices = choices.map((c) => {
          if (c.isCorrect && !foundFirst) {
            foundFirst = true;
            return c;
          }
          return { ...c, isCorrect: false };
        });
      }
      return { ...prev, type, choices };
    });
  };

  const handleChoiceTextChange = (choiceId: string, text: string) => {
    setQuestionForm((prev) => ({
      ...prev,
      choices: prev.choices.map((c) => (c.id === choiceId ? { ...c, text } : c)),
    }));
  };

  const handleChoiceCorrectChange = (choiceId: string, isCorrect: boolean) => {
    setQuestionForm((prev) => {
      let choices: QuizChoice[];
      if (prev.type === "single") {
        // Radio: only the clicked one is correct
        choices = prev.choices.map((c) => ({
          ...c,
          isCorrect: c.id === choiceId ? isCorrect : false,
        }));
      } else {
        choices = prev.choices.map((c) =>
          c.id === choiceId ? { ...c, isCorrect } : c
        );
      }
      return { ...prev, choices };
    });
  };

  const handleAddChoice = () => {
    setQuestionForm((prev) => {
      if (prev.choices.length >= 6) return prev;
      return { ...prev, choices: [...prev.choices, newChoice()] };
    });
  };

  const handleRemoveChoice = (choiceId: string) => {
    setQuestionForm((prev) => ({
      ...prev,
      choices: prev.choices.filter((c) => c.id !== choiceId),
    }));
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (quizLoading) {
    return (
      <section className="rounded-md border p-6 space-y-2">
        <h2 className="text-lg font-semibold">テスト</h2>
        <p className="text-sm text-muted-foreground">読み込み中...</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border p-6 space-y-4">
      <h2 className="text-lg font-semibold">テスト</h2>

      {quizError && (
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
          {quizError}
        </div>
      )}

      {!quiz ? (
        /* ── No quiz yet ── */
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            このレッスンにはまだテストが作成されていません。
          </p>
          <Button onClick={openCreateQuizDialog}>テストを作成</Button>
        </div>
      ) : (
        /* ── Quiz exists ── */
        <div className="space-y-6">
          {/* Quiz settings summary */}
          <div className="rounded-md bg-muted/40 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{quiz.title}</h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={openEditQuizDialog}>
                  設定を編集
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteQuiz}
                  disabled={deleteQuizLoading}
                >
                  {deleteQuizLoading ? "削除中..." : "削除"}
                </Button>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-lg">
              <dt className="text-muted-foreground">合格基準</dt>
              <dd>{quiz.passingScore}%</dd>

              <dt className="text-muted-foreground">最大受験回数</dt>
              <dd>{quiz.maxAttempts} 回</dd>

              <dt className="text-muted-foreground">制限時間</dt>
              <dd>{quiz.timeLimitSec != null ? `${quiz.timeLimitSec} 秒` : "無制限"}</dd>

              <dt className="text-muted-foreground">動画完了必須</dt>
              <dd>{quiz.requireVideoCompletion ? "はい" : "いいえ"}</dd>

              <dt className="text-muted-foreground">問題ランダム化</dt>
              <dd>{quiz.shuffleQuestions ? "有効" : "無効"}</dd>

              <dt className="text-muted-foreground">選択肢ランダム化</dt>
              <dd>{quiz.shuffleChoices ? "有効" : "無効"}</dd>
            </dl>

            {deleteQuizError && (
              <p className="text-sm text-destructive">{deleteQuizError}</p>
            )}
          </div>

          {/* Questions list */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">
                問題一覧{" "}
                <span className="text-sm text-muted-foreground font-normal">
                  ({quiz.questions.length} 問)
                </span>
              </h3>
              <Button size="sm" onClick={openAddQuestionDialog}>
                問題を追加
              </Button>
            </div>

            {quiz.questions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                問題がまだありません。「問題を追加」ボタンから追加してください。
              </p>
            ) : (
              <div className="space-y-3">
                {quiz.questions.map((q, idx) => (
                  <div
                    key={q.id}
                    className="rounded-md border p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium">
                          Q{idx + 1}.{" "}
                          <span className="font-normal">{q.text}</span>
                        </p>
                        <div className="flex gap-3 text-xs text-muted-foreground">
                          <span>
                            タイプ:{" "}
                            {q.type === "single" ? "単一選択" : "複数選択"}
                          </span>
                          <span>配点: {q.points} 点</span>
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditQuestionDialog(q)}
                        >
                          編集
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDeleteQuestion(q.id)}
                        >
                          削除
                        </Button>
                      </div>
                    </div>

                    {/* Choices */}
                    <ul className="space-y-1">
                      {q.choices.map((c) => (
                        <li
                          key={c.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span
                            className={
                              c.isCorrect
                                ? "text-green-600 font-medium"
                                : "text-muted-foreground"
                            }
                          >
                            {c.isCorrect ? "✓" : "○"}
                          </span>
                          <span>{c.text}</span>
                        </li>
                      ))}
                    </ul>

                    {q.explanation && (
                      <p className="text-xs text-muted-foreground border-t pt-2">
                        解説: {q.explanation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Quiz create/edit dialog ── */}
      <Dialog open={quizDialogOpen} onOpenChange={setQuizDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isEditingQuiz ? "テスト設定を編集" : "テストを作成"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="quiz-title">タイトル</Label>
              <Input
                id="quiz-title"
                value={quizForm.title}
                onChange={(e) =>
                  setQuizForm((p) => ({ ...p, title: e.target.value }))
                }
                placeholder="テストのタイトル"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="quiz-passing">合格基準 (%)</Label>
                <Input
                  id="quiz-passing"
                  type="number"
                  min={0}
                  max={100}
                  value={quizForm.passingScore}
                  onChange={(e) =>
                    setQuizForm((p) => ({
                      ...p,
                      passingScore: Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="quiz-attempts">最大受験回数</Label>
                <Input
                  id="quiz-attempts"
                  type="number"
                  min={1}
                  value={quizForm.maxAttempts}
                  onChange={(e) =>
                    setQuizForm((p) => ({
                      ...p,
                      maxAttempts: Number(e.target.value),
                    }))
                  }
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="quiz-timelimit">制限時間（秒）</Label>
              <Input
                id="quiz-timelimit"
                type="number"
                min={1}
                value={quizForm.timeLimitSec}
                onChange={(e) =>
                  setQuizForm((p) => ({ ...p, timeLimitSec: e.target.value }))
                }
                placeholder="空欄 = 無制限"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="quiz-require-video"
                  checked={quizForm.requireVideoCompletion}
                  onCheckedChange={(v) =>
                    setQuizForm((p) => ({
                      ...p,
                      requireVideoCompletion: Boolean(v),
                    }))
                  }
                />
                <Label htmlFor="quiz-require-video">動画完了必須</Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="quiz-shuffle-q"
                  checked={quizForm.shuffleQuestions}
                  onCheckedChange={(v) =>
                    setQuizForm((p) => ({
                      ...p,
                      shuffleQuestions: Boolean(v),
                    }))
                  }
                />
                <Label htmlFor="quiz-shuffle-q">問題ランダム化</Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="quiz-shuffle-c"
                  checked={quizForm.shuffleChoices}
                  onCheckedChange={(v) =>
                    setQuizForm((p) => ({
                      ...p,
                      shuffleChoices: Boolean(v),
                    }))
                  }
                />
                <Label htmlFor="quiz-shuffle-c">選択肢ランダム化</Label>
              </div>
            </div>

            {quizSaveError && (
              <p className="text-sm text-destructive">{quizSaveError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQuizDialogOpen(false)}
              disabled={quizSaving}
            >
              キャンセル
            </Button>
            <Button onClick={handleSaveQuiz} disabled={quizSaving}>
              {quizSaving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Question add/edit dialog ── */}
      <Dialog open={questionDialogOpen} onOpenChange={setQuestionDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingQuestion ? "問題を編集" : "問題を追加"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Question text */}
            <div className="space-y-1">
              <Label htmlFor="q-text">問題文</Label>
              <Textarea
                id="q-text"
                value={questionForm.text}
                onChange={(e) => updateQuestionField("text", e.target.value)}
                placeholder="問題文を入力してください"
                rows={3}
              />
            </div>

            {/* Type + points */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="q-type">タイプ</Label>
                <Select
                  value={questionForm.type}
                  onValueChange={(v) =>
                    handleQuestionTypeChange(v as "single" | "multi")
                  }
                >
                  <SelectTrigger id="q-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">単一選択</SelectItem>
                    <SelectItem value="multi">複数選択</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="q-points">配点</Label>
                <Input
                  id="q-points"
                  type="number"
                  min={1}
                  value={questionForm.points}
                  onChange={(e) =>
                    updateQuestionField("points", Number(e.target.value))
                  }
                />
              </div>
            </div>

            {/* Choices */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>
                  選択肢{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    ({questionForm.type === "single"
                      ? "1つ正解"
                      : "複数正解可"})
                  </span>
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddChoice}
                  disabled={questionForm.choices.length >= 6}
                >
                  選択肢を追加
                </Button>
              </div>

              <div className="space-y-2">
                {questionForm.choices.map((choice, idx) => (
                  <div key={choice.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`choice-correct-${choice.id}`}
                      checked={choice.isCorrect}
                      onCheckedChange={(v) =>
                        handleChoiceCorrectChange(choice.id, Boolean(v))
                      }
                    />
                    <Label
                      htmlFor={`choice-correct-${choice.id}`}
                      className="text-xs text-muted-foreground w-4 shrink-0"
                    >
                      {idx + 1}
                    </Label>
                    <Input
                      value={choice.text}
                      onChange={(e) =>
                        handleChoiceTextChange(choice.id, e.target.value)
                      }
                      placeholder={`選択肢 ${idx + 1}`}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveChoice(choice.id)}
                      disabled={questionForm.choices.length <= 2}
                      className="shrink-0 text-destructive hover:text-destructive"
                    >
                      削除
                    </Button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                チェックボックスをオンにした選択肢が正解になります。
              </p>
            </div>

            {/* Explanation */}
            <div className="space-y-1">
              <Label htmlFor="q-explanation">解説（任意）</Label>
              <Textarea
                id="q-explanation"
                value={questionForm.explanation}
                onChange={(e) =>
                  updateQuestionField("explanation", e.target.value)
                }
                placeholder="解説文を入力してください"
                rows={2}
              />
            </div>

            {questionSaveError && (
              <p className="text-sm text-destructive">{questionSaveError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQuestionDialogOpen(false)}
              disabled={questionSaving}
            >
              キャンセル
            </Button>
            <Button onClick={handleSaveQuestion} disabled={questionSaving}>
              {questionSaving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LessonDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const lessonId = params.lessonId as string;
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  const [lessonDetail, setLessonDetail] = useState<LessonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);

  // Delete state
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Google Drive import state
  const [videoSourceMode, setVideoSourceMode] = useState<"upload" | "google_drive">("upload");
  const [driveUrl, setDriveUrl] = useState("");
  const [driveDurationSec, setDriveDurationSec] = useState("");
  const [driveImporting, setDriveImporting] = useState(false);
  const [driveImportStatus, setDriveImportStatus] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await authFetch<LessonDetail>(
        `/api/v1/admin/courses/${courseId}/lessons/${lessonId}`
      );
      setLessonDetail(data);

      // Fetch playback URL if video exists
      if (data.video) {
        try {
          const playbackData = await authFetch<{ playbackUrl: string }>(
            `/api/v1/videos/${data.video.id}/playback-url`
          );
          setLessonDetail((prev) =>
            prev
              ? {
                  ...prev,
                  video: prev.video
                    ? { ...prev.video, playbackUrl: playbackData.playbackUrl }
                    : null,
                }
              : null
          );
        } catch {
          // playback URL fetch failure is non-fatal
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch, courseId, lessonId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setDurationSec(null);
    setUploadError(null);

    if (file) {
      // Extract duration via a temporary video element
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        setDurationSec(Math.floor(vid.duration));
        URL.revokeObjectURL(url);
      };
      vid.src = url;
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    try {
      // Step 1: Get signed upload URL
      const { uploadUrl, gcsPath } = await authFetch<{
        uploadUrl: string;
        gcsPath: string;
      }>("/api/v1/admin/videos/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type,
        }),
      });

      // Step 2: Upload directly to GCS with progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`GCSアップロードに失敗しました (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error("ネットワークエラーが発生しました"));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", selectedFile.type);
        xhr.send(selectedFile);
      });

      // Step 3: Register video metadata
      await authFetch(`/api/v1/admin/lessons/${lessonId}/video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gcsPath,
          sourceType: "gcs",
          durationSec,
        }),
      });

      setSelectedFile(null);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
      fetchData();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteVideo = async () => {
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await authFetch(`/api/v1/admin/lessons/${lessonId}/video`, {
        method: "DELETE",
      });
      fetchData();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDriveImport = async () => {
    if (!driveUrl) return;
    setDriveImporting(true);
    setUploadError(null);
    setDriveImportStatus("pending");

    try {
      const data = await authFetch<{ video: { id: string } }>(
        `/api/v1/admin/videos/import-from-drive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driveUrl,
            lessonId,
            durationSec: driveDurationSec ? Number(driveDurationSec) : 0,
          }),
        },
      );

      setDriveImportStatus("importing");

      // ポーリング
      const maxAttempts = 120;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const status = await authFetch<{
            importStatus: string | null;
            importError: string | null;
          }>(`/api/v1/admin/videos/${data.video.id}/import-status`);

          setDriveImportStatus(status.importStatus ?? "unknown");

          if (status.importStatus === "completed") {
            setDriveUrl("");
            setDriveDurationSec("");
            fetchData();
            return;
          }
          if (status.importStatus === "error") {
            setUploadError(status.importError ?? "インポートに失敗しました");
            return;
          }
        } catch {
          // ポーリングエラーは無視
        }
      }
      setUploadError("インポートがタイムアウトしました");
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "インポートに失敗しました");
    } finally {
      setDriveImporting(false);
      setDriveImportStatus(null);
    }
  };

  const lesson = lessonDetail?.lesson;
  const video = lessonDetail?.video;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={`/${tenantId}/admin/courses`} className="hover:text-foreground">
          講座管理
        </Link>
        <span>/</span>
        <Link
          href={`/${tenantId}/admin/courses/${courseId}/lessons`}
          className="hover:text-foreground"
        >
          レッスン管理
        </Link>
        <span>/</span>
        <span className="text-foreground">{lesson?.title ?? "読み込み中..."}</span>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">レッスン詳細</h1>
        {lesson && (
          <p className="text-sm text-muted-foreground mt-1">
            順序: {lesson.order} &nbsp;|&nbsp; {lesson.title}
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : (
        <>
          {/* Video Section */}
          <section className="rounded-md border p-6 space-y-4">
            <h2 className="text-lg font-semibold">動画</h2>

            {video ? (
              /* Video registered */
              <div className="space-y-4">
                {video.playbackUrl && (
                  <video
                    ref={videoPreviewRef}
                    src={video.playbackUrl}
                    controls
                    className="w-full max-w-md rounded-md border"
                  />
                )}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-md">
                  <dt className="text-muted-foreground">GCSパス</dt>
                  <dd className="truncate font-mono text-xs">{video.gcsPath}</dd>

                  <dt className="text-muted-foreground">再生時間</dt>
                  <dd>
                    {video.durationSec != null
                      ? `${video.durationSec} 秒`
                      : "不明"}
                  </dd>

                  <dt className="text-muted-foreground">必須視聴割合</dt>
                  <dd>{(video.requiredWatchRatio * 100).toFixed(0)}%</dd>

                  <dt className="text-muted-foreground">速度ロック</dt>
                  <dd>{video.speedLock ? "有効" : "無効"}</dd>
                </dl>

                {deleteError && (
                  <div className="text-sm text-destructive">{deleteError}</div>
                )}

                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteVideo}
                  disabled={deleteLoading}
                >
                  {deleteLoading ? "削除中..." : "動画を削除"}
                </Button>
              </div>
            ) : (
              /* No video — show upload form */
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  動画がまだ登録されていません。
                </p>

                {/* Source mode tabs */}
                <div className="flex gap-2 border-b">
                  <button
                    className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      videoSourceMode === "upload"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setVideoSourceMode("upload")}
                  >
                    ファイルアップロード
                  </button>
                  <button
                    className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      videoSourceMode === "google_drive"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setVideoSourceMode("google_drive")}
                  >
                    Google Drive
                  </button>
                </div>

                {videoSourceMode === "upload" ? (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">動画ファイル</label>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        onChange={handleFileChange}
                        disabled={uploading}
                        className="block text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 disabled:opacity-50"
                      />
                    </div>

                    {selectedFile && (
                      <p className="text-sm text-muted-foreground">
                        {selectedFile.name}{" "}
                        {durationSec != null && `(${durationSec} 秒)`}
                      </p>
                    )}

                    {uploading && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-sm text-muted-foreground">
                          <span>アップロード中...</span>
                          <span>{uploadProgress}%</span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all duration-200"
                            style={{ width: `${uploadProgress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <Button
                      onClick={handleUpload}
                      disabled={!selectedFile || uploading}
                    >
                      {uploading ? "アップロード中..." : "アップロード"}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Google Drive URL</label>
                      <Input
                        value={driveUrl}
                        onChange={(e) => setDriveUrl(e.target.value)}
                        placeholder="https://drive.google.com/file/d/.../view"
                        disabled={driveImporting}
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">再生時間（秒）</label>
                      <Input
                        type="number"
                        value={driveDurationSec}
                        onChange={(e) => setDriveDurationSec(e.target.value)}
                        placeholder="例: 300"
                        disabled={driveImporting}
                      />
                    </div>

                    {driveImportStatus && (
                      <div className="text-sm text-muted-foreground">
                        {driveImportStatus === "importing" && "インポート中...GCSへコピーしています"}
                        {driveImportStatus === "pending" && "待機中..."}
                        {driveImportStatus === "completed" && "インポート完了"}
                      </div>
                    )}

                    <Button
                      onClick={handleDriveImport}
                      disabled={!driveUrl || driveImporting}
                    >
                      {driveImporting ? "インポート中..." : "Google Driveからインポート"}
                    </Button>
                  </>
                )}

                {uploadError && (
                  <div className="text-sm text-destructive">{uploadError}</div>
                )}
              </div>
            )}
          </section>

          {/* Quiz Section */}
          <QuizSection lessonId={lessonId} />
        </>
      )}
    </div>
  );
}
