"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSuperAdminFetch } from "@/lib/super-api";

// --- Types ---

type Course = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lessonOrder: string[];
  passThreshold: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type Lesson = {
  id: string;
  courseId: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
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

// --- Helpers ---

let idCounter = 0;
function genId(): string {
  return `tmp_${Date.now()}_${++idCounter}`;
}

function emptyOption(): QuestionOption {
  return { id: genId(), text: "", isCorrect: false };
}

function emptyQuestion(): Question {
  return {
    id: genId(),
    text: "",
    type: "single",
    options: [emptyOption(), emptyOption()],
    points: 1,
    explanation: "",
  };
}

// --- Component ---

export default function MasterCourseDetailPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const { superFetch } = useSuperAdminFetch();

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Expanded sections per lesson
  const [expandedLessons, setExpandedLessons] = useState<Set<string>>(
    new Set(),
  );

  // Lesson create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Lesson edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Lesson delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingLesson, setDeletingLesson] = useState<Lesson | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Video form state (per lesson, tracked by lessonId)
  const [videoForms, setVideoForms] = useState<
    Record<
      string,
      {
        sourceType: "gcs" | "external_url" | "google_drive";
        gcsPath: string;
        sourceUrl: string;
        driveUrl: string;
        durationSec: string;
      }
    >
  >({});
  const [videoSaving, setVideoSaving] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<
    Record<string, { status: string; error?: string | null }>
  >({});

  // Quiz form state (per lesson, tracked by lessonId)
  const [quizForms, setQuizForms] = useState<
    Record<string, { title: string; questions: Question[] }>
  >({});
  const [quizSaving, setQuizSaving] = useState<string | null>(null);
  const [quizError, setQuizError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await superFetch<{ course: Course; lessons: Lesson[] }>(
        `/api/v2/super/master/courses/${courseId}`,
      );
      setCourse(data.course);
      const sorted = [...data.lessons].sort((a, b) => a.order - b.order);
      setLessons(sorted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [superFetch, courseId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleExpanded = (lessonId: string) => {
    setExpandedLessons((prev) => {
      const next = new Set(prev);
      if (next.has(lessonId)) {
        next.delete(lessonId);
      } else {
        next.add(lessonId);
      }
      return next;
    });
  };

  // --- Lesson CRUD ---

  const handleCreateLesson = async () => {
    if (!createTitle.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await superFetch(
        `/api/v2/super/master/courses/${courseId}/lessons`,
        {
          method: "POST",
          body: JSON.stringify({ title: createTitle.trim() }),
        },
      );
      setCreateOpen(false);
      setCreateTitle("");
      fetchData();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreateLoading(false);
    }
  };

  const openEditLesson = (lesson: Lesson) => {
    setEditingLesson(lesson);
    setEditTitle(lesson.title);
    setEditError(null);
    setEditOpen(true);
  };

  const handleEditLesson = async () => {
    if (!editingLesson || !editTitle.trim()) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await superFetch(
        `/api/v2/super/master/lessons/${editingLesson.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: editTitle.trim() }),
        },
      );
      setEditOpen(false);
      setEditingLesson(null);
      fetchData();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  const openDeleteLesson = (lesson: Lesson) => {
    setDeletingLesson(lesson);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleDeleteLesson = async () => {
    if (!deletingLesson) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await superFetch(
        `/api/v2/super/master/lessons/${deletingLesson.id}`,
        { method: "DELETE" },
      );
      setDeleteOpen(false);
      setDeletingLesson(null);
      fetchData();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  // --- Video ---

  const getVideoForm = (lessonId: string) =>
    videoForms[lessonId] ?? {
      sourceType: "gcs" as const,
      gcsPath: "",
      sourceUrl: "",
      driveUrl: "",
      durationSec: "",
    };

  const updateVideoForm = (
    lessonId: string,
    updates: Partial<ReturnType<typeof getVideoForm>>,
  ) => {
    setVideoForms((prev) => ({
      ...prev,
      [lessonId]: { ...getVideoForm(lessonId), ...updates },
    }));
  };

  const pollImportStatus = async (videoId: string, lessonId: string) => {
    const maxAttempts = 120; // 最大10分（5秒間隔）
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const data = await superFetch<{
          videoId: string;
          importStatus: string | null;
          importError: string | null;
        }>(`/api/v2/super/master/videos/${videoId}/import-status`);

        setImportStatus((prev) => ({
          ...prev,
          [lessonId]: { status: data.importStatus ?? "unknown", error: data.importError },
        }));

        if (data.importStatus === "completed") {
          fetchData();
          return;
        }
        if (data.importStatus === "error") {
          setVideoError(data.importError ?? "インポートに失敗しました");
          return;
        }
      } catch {
        // ポーリングエラーは無視して次の試行へ
      }
    }
    setVideoError("インポートがタイムアウトしました");
  };

  const handleSaveVideo = async (lessonId: string) => {
    const form = getVideoForm(lessonId);
    setVideoSaving(lessonId);
    setVideoError(null);
    try {
      if (form.sourceType === "google_drive") {
        // Google Driveインポート
        const body = {
          driveUrl: form.driveUrl,
          lessonId,
          durationSec: form.durationSec ? Number(form.durationSec) : 0,
        };
        const data = await superFetch<{ video: { id: string } }>(
          `/api/v2/super/master/videos/import-from-drive`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        setImportStatus((prev) => ({
          ...prev,
          [lessonId]: { status: "importing" },
        }));
        setVideoSaving(null);
        // バックグラウンドでポーリング
        pollImportStatus(data.video.id, lessonId);
        return;
      }

      // GCS / 外部URL
      const body: Record<string, unknown> = {
        sourceType: form.sourceType,
      };
      if (form.sourceType === "gcs") {
        body.gcsPath = form.gcsPath;
      } else {
        body.sourceUrl = form.sourceUrl;
      }
      if (form.durationSec) {
        body.durationSec = Number(form.durationSec);
      }
      await superFetch(
        `/api/v2/super/master/lessons/${lessonId}/video`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      fetchData();
    } catch (e) {
      setVideoError(
        e instanceof Error ? e.message : "動画の保存に失敗しました",
      );
    } finally {
      setVideoSaving(null);
    }
  };

  const handleDeleteVideo = async (lessonId: string) => {
    setVideoSaving(lessonId);
    setVideoError(null);
    try {
      await superFetch(
        `/api/v2/super/master/lessons/${lessonId}/video`,
        { method: "DELETE" },
      );
      fetchData();
    } catch (e) {
      setVideoError(
        e instanceof Error ? e.message : "動画の削除に失敗しました",
      );
    } finally {
      setVideoSaving(null);
    }
  };

  // --- Quiz ---

  const getQuizForm = (lessonId: string) =>
    quizForms[lessonId] ?? { title: "", questions: [emptyQuestion()] };

  const updateQuizForm = (
    lessonId: string,
    updates: Partial<ReturnType<typeof getQuizForm>>,
  ) => {
    setQuizForms((prev) => ({
      ...prev,
      [lessonId]: { ...getQuizForm(lessonId), ...updates },
    }));
  };

  const updateQuestion = (
    lessonId: string,
    qIndex: number,
    updates: Partial<Question>,
  ) => {
    const form = getQuizForm(lessonId);
    const questions = [...form.questions];
    questions[qIndex] = { ...questions[qIndex], ...updates };
    updateQuizForm(lessonId, { questions });
  };

  const updateOption = (
    lessonId: string,
    qIndex: number,
    oIndex: number,
    updates: Partial<QuestionOption>,
  ) => {
    const form = getQuizForm(lessonId);
    const questions = [...form.questions];
    const options = [...questions[qIndex].options];
    options[oIndex] = { ...options[oIndex], ...updates };
    questions[qIndex] = { ...questions[qIndex], options };
    updateQuizForm(lessonId, { questions });
  };

  const addQuestion = (lessonId: string) => {
    const form = getQuizForm(lessonId);
    updateQuizForm(lessonId, {
      questions: [...form.questions, emptyQuestion()],
    });
  };

  const removeQuestion = (lessonId: string, qIndex: number) => {
    const form = getQuizForm(lessonId);
    const questions = form.questions.filter((_, i) => i !== qIndex);
    updateQuizForm(lessonId, {
      questions: questions.length > 0 ? questions : [emptyQuestion()],
    });
  };

  const addOption = (lessonId: string, qIndex: number) => {
    const form = getQuizForm(lessonId);
    const questions = [...form.questions];
    questions[qIndex] = {
      ...questions[qIndex],
      options: [
        ...questions[qIndex].options,
        emptyOption(),
      ],
    };
    updateQuizForm(lessonId, { questions });
  };

  const removeOption = (
    lessonId: string,
    qIndex: number,
    oIndex: number,
  ) => {
    const form = getQuizForm(lessonId);
    const questions = [...form.questions];
    const options = questions[qIndex].options.filter((_, i) => i !== oIndex);
    if (options.length < 2) return; // minimum 2 options
    questions[qIndex] = { ...questions[qIndex], options };
    updateQuizForm(lessonId, { questions });
  };

  const handleSaveQuiz = async (lessonId: string) => {
    const form = getQuizForm(lessonId);
    if (!form.title.trim()) return;
    setQuizSaving(lessonId);
    setQuizError(null);
    try {
      await superFetch(
        `/api/v2/super/master/lessons/${lessonId}/quiz`,
        {
          method: "POST",
          body: JSON.stringify({
            title: form.title.trim(),
            questions: form.questions,
          }),
        },
      );
      fetchData();
    } catch (e) {
      setQuizError(
        e instanceof Error ? e.message : "テストの保存に失敗しました",
      );
    } finally {
      setQuizSaving(null);
    }
  };

  const handleDeleteQuiz = async (lessonId: string) => {
    setQuizSaving(lessonId);
    setQuizError(null);
    try {
      await superFetch(
        `/api/v2/super/master/lessons/${lessonId}/quiz`,
        { method: "DELETE" },
      );
      fetchData();
    } catch (e) {
      setQuizError(
        e instanceof Error ? e.message : "テストの削除に失敗しました",
      );
    } finally {
      setQuizSaving(null);
    }
  };

  // --- Render ---

  if (loading) {
    return <div className="text-muted-foreground">読み込み中...</div>;
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href="/super/master/courses"
          className="hover:text-foreground"
        >
          マスターコース
        </Link>
        <span>/</span>
        <span className="text-foreground">{course?.name ?? ""}</span>
      </div>

      {/* Course info */}
      <div>
        <h1 className="text-2xl font-bold">{course?.name}</h1>
        {course?.description && (
          <p className="text-sm text-muted-foreground mt-1">
            {course.description}
          </p>
        )}
      </div>

      {/* Lessons header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">レッスン一覧</h2>
        <Button
          onClick={() => {
            setCreateTitle("");
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          レッスン追加
        </Button>
      </div>

      {lessons.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          レッスンがありません
        </div>
      ) : (
        <div className="space-y-4">
          {lessons.map((lesson, index) => {
            const isExpanded = expandedLessons.has(lesson.id);
            const vForm = getVideoForm(lesson.id);
            const qForm = getQuizForm(lesson.id);

            return (
              <div
                key={lesson.id}
                className="border rounded-lg"
              >
                {/* Lesson header row */}
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground font-mono">
                      {index + 1}
                    </span>
                    <span className="font-medium">{lesson.title}</span>
                    <div className="flex gap-1.5">
                      {lesson.hasVideo ? (
                        <Badge className="bg-blue-100 text-blue-800 border-blue-200">
                          動画あり
                        </Badge>
                      ) : (
                        <Badge variant="outline">動画なし</Badge>
                      )}
                      {lesson.hasQuiz ? (
                        <Badge className="bg-purple-100 text-purple-800 border-purple-200">
                          テストあり
                        </Badge>
                      ) : (
                        <Badge variant="outline">テストなし</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleExpanded(lesson.id)}
                    >
                      {isExpanded ? "閉じる" : "動画/テスト管理"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditLesson(lesson)}
                    >
                      編集
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => openDeleteLesson(lesson)}
                    >
                      削除
                    </Button>
                  </div>
                </div>

                {/* Expanded: Video + Quiz management */}
                {isExpanded && (
                  <div className="border-t p-4 space-y-6 bg-muted/30">
                    {/* Video section */}
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold">動画設定</h3>
                      {lesson.hasVideo ? (
                        <div className="flex items-center gap-3">
                          <Badge className="bg-blue-100 text-blue-800 border-blue-200">
                            登録済み
                          </Badge>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDeleteVideo(lesson.id)}
                            disabled={videoSaving === lesson.id}
                          >
                            {videoSaving === lesson.id
                              ? "削除中..."
                              : "動画を削除"}
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-sm font-medium">
                                ソースタイプ
                              </label>
                              <Select
                                value={vForm.sourceType}
                                onValueChange={(v) =>
                                  updateVideoForm(lesson.id, {
                                    sourceType: v as "gcs" | "external_url" | "google_drive",
                                  })
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="gcs">GCS</SelectItem>
                                  <SelectItem value="external_url">
                                    外部URL
                                  </SelectItem>
                                  <SelectItem value="google_drive">
                                    Google Drive
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1">
                              <label className="text-sm font-medium">
                                再生時間（秒）
                              </label>
                              <Input
                                type="number"
                                value={vForm.durationSec}
                                onChange={(e) =>
                                  updateVideoForm(lesson.id, {
                                    durationSec: e.target.value,
                                  })
                                }
                                placeholder="例: 300"
                              />
                            </div>
                          </div>
                          {vForm.sourceType === "gcs" ? (
                            <div className="space-y-1">
                              <label className="text-sm font-medium">
                                GCSパス
                              </label>
                              <Input
                                value={vForm.gcsPath}
                                onChange={(e) =>
                                  updateVideoForm(lesson.id, {
                                    gcsPath: e.target.value,
                                  })
                                }
                                placeholder="例: videos/course1/lesson1.mp4"
                              />
                            </div>
                          ) : vForm.sourceType === "google_drive" ? (
                            <div className="space-y-1">
                              <label className="text-sm font-medium">
                                Google Drive URL
                              </label>
                              <Input
                                value={vForm.driveUrl}
                                onChange={(e) =>
                                  updateVideoForm(lesson.id, {
                                    driveUrl: e.target.value,
                                  })
                                }
                                placeholder="https://drive.google.com/file/d/.../view"
                              />
                              {importStatus[lesson.id] && (
                                <div className={`text-sm mt-1 ${
                                  importStatus[lesson.id].status === "error"
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                                }`}>
                                  {importStatus[lesson.id].status === "importing" && "インポート中..."}
                                  {importStatus[lesson.id].status === "pending" && "待機中..."}
                                  {importStatus[lesson.id].status === "completed" && "インポート完了"}
                                  {importStatus[lesson.id].status === "error" &&
                                    `エラー: ${importStatus[lesson.id].error}`}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <label className="text-sm font-medium">
                                外部URL
                              </label>
                              <Input
                                value={vForm.sourceUrl}
                                onChange={(e) =>
                                  updateVideoForm(lesson.id, {
                                    sourceUrl: e.target.value,
                                  })
                                }
                                placeholder="https://..."
                              />
                            </div>
                          )}
                          <Button
                            size="sm"
                            onClick={() => handleSaveVideo(lesson.id)}
                            disabled={videoSaving === lesson.id}
                          >
                            {videoSaving === lesson.id
                              ? "保存中..."
                              : "動画を登録"}
                          </Button>
                        </div>
                      )}
                      {videoError && videoSaving === null && (
                        <div className="text-sm text-destructive">
                          {videoError}
                        </div>
                      )}
                    </div>

                    {/* Quiz section */}
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold">テスト設定</h3>
                      {lesson.hasQuiz ? (
                        <div className="flex items-center gap-3">
                          <Badge className="bg-purple-100 text-purple-800 border-purple-200">
                            登録済み
                          </Badge>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDeleteQuiz(lesson.id)}
                            disabled={quizSaving === lesson.id}
                          >
                            {quizSaving === lesson.id
                              ? "削除中..."
                              : "テストを削除"}
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="space-y-1">
                            <label className="text-sm font-medium">
                              テストタイトル
                            </label>
                            <Input
                              value={qForm.title}
                              onChange={(e) =>
                                updateQuizForm(lesson.id, {
                                  title: e.target.value,
                                })
                              }
                              placeholder="テストタイトルを入力"
                            />
                          </div>

                          {/* Questions */}
                          <div className="space-y-4">
                            {qForm.questions.map((q, qIdx) => (
                              <div
                                key={qIdx}
                                className="border rounded p-3 space-y-3 bg-background"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium">
                                    問題 {qIdx + 1}
                                  </span>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() =>
                                      removeQuestion(lesson.id, qIdx)
                                    }
                                  >
                                    削除
                                  </Button>
                                </div>
                                <div className="space-y-1">
                                  <label className="text-xs text-muted-foreground">
                                    問題文
                                  </label>
                                  <Textarea
                                    value={q.text}
                                    onChange={(e) =>
                                      updateQuestion(lesson.id, qIdx, {
                                        text: e.target.value,
                                      })
                                    }
                                    placeholder="問題文を入力"
                                    rows={2}
                                  />
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">
                                      種類
                                    </label>
                                    <Select
                                      value={q.type}
                                      onValueChange={(v) =>
                                        updateQuestion(lesson.id, qIdx, {
                                          type: v as "single" | "multi",
                                        })
                                      }
                                    >
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="single">
                                          単一選択
                                        </SelectItem>
                                        <SelectItem value="multi">
                                          複数選択
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">
                                      配点
                                    </label>
                                    <Input
                                      type="number"
                                      min={1}
                                      value={q.points}
                                      onChange={(e) =>
                                        updateQuestion(lesson.id, qIdx, {
                                          points:
                                            Number(e.target.value) || 1,
                                        })
                                      }
                                    />
                                  </div>
                                </div>

                                {/* Options */}
                                <div className="space-y-2">
                                  <label className="text-xs text-muted-foreground">
                                    選択肢
                                  </label>
                                  {q.options.map((opt, oIdx) => (
                                    <div
                                      key={oIdx}
                                      className="flex items-center gap-2"
                                    >
                                      <Checkbox
                                        checked={opt.isCorrect}
                                        onCheckedChange={(checked) =>
                                          updateOption(
                                            lesson.id,
                                            qIdx,
                                            oIdx,
                                            {
                                              isCorrect: checked === true,
                                            },
                                          )
                                        }
                                      />
                                      <Input
                                        value={opt.text}
                                        onChange={(e) =>
                                          updateOption(
                                            lesson.id,
                                            qIdx,
                                            oIdx,
                                            { text: e.target.value },
                                          )
                                        }
                                        placeholder={`選択肢 ${oIdx + 1}`}
                                        className="flex-1"
                                      />
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() =>
                                          removeOption(
                                            lesson.id,
                                            qIdx,
                                            oIdx,
                                          )
                                        }
                                        disabled={q.options.length <= 2}
                                      >
                                        x
                                      </Button>
                                    </div>
                                  ))}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      addOption(lesson.id, qIdx)
                                    }
                                  >
                                    選択肢を追加
                                  </Button>
                                </div>

                                <div className="space-y-1">
                                  <label className="text-xs text-muted-foreground">
                                    解説
                                  </label>
                                  <Textarea
                                    value={q.explanation}
                                    onChange={(e) =>
                                      updateQuestion(lesson.id, qIdx, {
                                        explanation: e.target.value,
                                      })
                                    }
                                    placeholder="解説を入力（任意）"
                                    rows={2}
                                  />
                                </div>
                              </div>
                            ))}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => addQuestion(lesson.id)}
                            >
                              問題を追加
                            </Button>
                          </div>

                          <Button
                            size="sm"
                            onClick={() => handleSaveQuiz(lesson.id)}
                            disabled={
                              quizSaving === lesson.id ||
                              !qForm.title.trim()
                            }
                          >
                            {quizSaving === lesson.id
                              ? "保存中..."
                              : "テストを登録"}
                          </Button>
                        </div>
                      )}
                      {quizError && quizSaving === null && (
                        <div className="text-sm text-destructive">
                          {quizError}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Lesson create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レッスンを追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">タイトル</label>
              <Input
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="レッスンタイトルを入力"
              />
            </div>
            {createError && (
              <div className="text-sm text-destructive">{createError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleCreateLesson}
              disabled={createLoading || !createTitle.trim()}
            >
              {createLoading ? "作成中..." : "作成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lesson edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レッスンを編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">タイトル</label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="レッスンタイトルを入力"
              />
            </div>
            {editError && (
              <div className="text-sm text-destructive">{editError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleEditLesson}
              disabled={editLoading || !editTitle.trim()}
            >
              {editLoading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lesson delete dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レッスンを削除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「{deletingLesson?.title}
            」を削除しますか？この操作は取り消せません。
          </p>
          {deleteError && (
            <div className="text-sm text-destructive">{deleteError}</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteLesson}
              disabled={deleteLoading}
            >
              {deleteLoading ? "削除中..." : "削除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
