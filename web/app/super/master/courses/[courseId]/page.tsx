"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
  const superFetchRef = useRef(superFetch);
  superFetchRef.current = superFetch;

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

  // Video source mode per lesson (upload or google_drive)
  const [videoSourceMode, setVideoSourceMode] = useState<Record<string, "upload" | "google_drive">>({});
  // File upload state
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File | null>>({});
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadDurations, setUploadDurations] = useState<Record<string, number | null>>({});

  // Quiz form state (per lesson, tracked by lessonId)
  const [quizForms, setQuizForms] = useState<
    Record<string, { title: string; questions: Question[] }>
  >({});
  const [quizSaving, setQuizSaving] = useState<string | null>(null);
  const [quizError, setQuizError] = useState<string | null>(null);

  // Quiz generation state
  const [quizGenDialog, setQuizGenDialog] = useState<string | null>(null); // lessonId or null
  const [quizGenDocsUrl, setQuizGenDocsUrl] = useState("");
  const [quizGenCount, setQuizGenCount] = useState("10");
  const [quizGenDifficulty, setQuizGenDifficulty] = useState("medium");
  const [quizGenerating, setQuizGenerating] = useState(false);
  const [quizGenError, setQuizGenError] = useState<string | null>(null);

  // Quiz import state
  const [quizImportDialog, setQuizImportDialog] = useState<string | null>(null); // lessonId or null
  const [quizImportDocsUrl, setQuizImportDocsUrl] = useState("");
  const [quizImporting, setQuizImporting] = useState(false);
  const [quizImportError, setQuizImportError] = useState<string | null>(null);
  const [quizImportTabs, setQuizImportTabs] = useState<{ id: string; title: string }[] | null>(null);
  const [quizImportSelectedTab, setQuizImportSelectedTab] = useState<string | null>(null);
  const [quizImportWarnings, setQuizImportWarnings] = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await superFetchRef.current<{ course: Course; lessons: Lesson[] }>(
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
  }, [courseId]);

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

  const handleFileChange = (lessonId: string, file: File | null) => {
    setSelectedFiles((prev) => ({ ...prev, [lessonId]: file }));
    setUploadDurations((prev) => ({ ...prev, [lessonId]: null }));
    if (file) {
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        setUploadDurations((prev) => ({ ...prev, [lessonId]: Math.floor(vid.duration) }));
        URL.revokeObjectURL(url);
      };
      vid.src = url;
    }
  };

  const handleFileUpload = async (lessonId: string) => {
    const file = selectedFiles[lessonId];
    if (!file) return;
    setVideoSaving(lessonId);
    setVideoError(null);
    setUploadProgress((prev) => ({ ...prev, [lessonId]: 0 }));

    try {
      // Step 1: 署名付きアップロードURL取得
      const { uploadUrl, gcsPath } = await superFetch<{
        uploadUrl: string;
        gcsPath: string;
      }>("/api/v2/super/master/videos/upload-url", {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
        }),
      });

      // Step 2: GCSに直接アップロード
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploadProgress((prev) => ({
              ...prev,
              [lessonId]: Math.round((event.loaded / event.total) * 100),
            }));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`アップロード失敗 (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("ネットワークエラー"));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.send(file);
      });

      // Step 3: 動画メタデータ登録
      await superFetch(`/api/v2/super/master/lessons/${lessonId}/video`, {
        method: "POST",
        body: JSON.stringify({
          gcsPath,
          sourceType: "gcs",
          durationSec: uploadDurations[lessonId] ?? 0,
        }),
      });

      setSelectedFiles((prev) => ({ ...prev, [lessonId]: null }));
      setUploadProgress((prev) => ({ ...prev, [lessonId]: 0 }));
      fetchData();
    } catch (e) {
      setVideoError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setVideoSaving(null);
    }
  };

  const handleSaveVideo = async (lessonId: string) => {
    const form = getVideoForm(lessonId);
    setVideoSaving(lessonId);
    setVideoError(null);
    try {
      const body = {
        driveUrl: form.driveUrl,
        lessonId,
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
      pollImportStatus(data.video.id, lessonId);
    } catch (e) {
      setVideoError(
        e instanceof Error ? e.message : "動画の保存に失敗しました",
      );
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

  const handleGenerateQuiz = async (lessonId: string) => {
    setQuizGenerating(true);
    setQuizGenError(null);
    try {
      const data = await superFetch<{
        generatedQuestions: Question[];
        suggestedTitle: string;
      }>(`/api/v2/super/master/lessons/${lessonId}/quiz/generate`, {
        method: "POST",
        body: JSON.stringify({
          docsUrl: quizGenDocsUrl,
          questionCount: Number(quizGenCount) || 10,
          difficulty: quizGenDifficulty,
          language: "ja",
        }),
      });

      // 生成結果をクイズフォームにセット
      updateQuizForm(lessonId, {
        title: data.suggestedTitle,
        questions: data.generatedQuestions,
      });

      // ダイアログを閉じる
      setQuizGenDialog(null);
      setQuizGenDocsUrl("");
    } catch (e) {
      setQuizGenError(
        e instanceof Error ? e.message : "クイズ生成に失敗しました",
      );
    } finally {
      setQuizGenerating(false);
    }
  };

  const handleImportQuiz = async (lessonId: string) => {
    setQuizImporting(true);
    setQuizImportError(null);
    try {
      const body: Record<string, unknown> = { docsUrl: quizImportDocsUrl };
      if (quizImportSelectedTab) {
        body.tabId = quizImportSelectedTab;
      }

      const data = await superFetch<{
        action: "select_tab" | "imported";
        tabs?: { id: string; title: string }[];
        importedQuestions?: Question[];
        suggestedTitle?: string;
        documentTitle?: string;
        warnings?: string[];
      }>(`/api/v2/super/master/lessons/${lessonId}/quiz/import`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (data.action === "select_tab" && data.tabs) {
        setQuizImportTabs(data.tabs);
        return;
      }

      if (data.action === "imported" && data.importedQuestions) {
        // isCorrect: null → false に変換
        const questions = data.importedQuestions.map((q) => ({
          ...q,
          options: q.options.map((o) => ({
            ...o,
            isCorrect: o.isCorrect ?? false,
          })),
        }));

        updateQuizForm(lessonId, {
          title: data.suggestedTitle ?? "",
          questions,
        });

        setQuizImportWarnings(data.warnings ?? []);
        setQuizImportDialog(null);
        setQuizImportDocsUrl("");
        setQuizImportTabs(null);
        setQuizImportSelectedTab(null);
      }
    } catch (e) {
      setQuizImportError(
        e instanceof Error ? e.message : "インポートに失敗しました",
      );
    } finally {
      setQuizImporting(false);
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
                          {/* Source mode tabs */}
                          <div className="flex gap-2 border-b">
                            <button
                              className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                                (videoSourceMode[lesson.id] ?? "upload") === "upload"
                                  ? "border-primary text-primary"
                                  : "border-transparent text-muted-foreground hover:text-foreground"
                              }`}
                              onClick={() => setVideoSourceMode((prev) => ({ ...prev, [lesson.id]: "upload" }))}
                            >
                              ファイルアップロード
                            </button>
                            <button
                              className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                                videoSourceMode[lesson.id] === "google_drive"
                                  ? "border-primary text-primary"
                                  : "border-transparent text-muted-foreground hover:text-foreground"
                              }`}
                              onClick={() => setVideoSourceMode((prev) => ({ ...prev, [lesson.id]: "google_drive" }))}
                            >
                              Google Drive
                            </button>
                          </div>

                          {(videoSourceMode[lesson.id] ?? "upload") === "upload" ? (
                            <>
                              <div className="space-y-2">
                                <label className="text-sm font-medium">動画ファイル</label>
                                <input
                                  type="file"
                                  accept="video/*"
                                  onChange={(e) => handleFileChange(lesson.id, e.target.files?.[0] ?? null)}
                                  disabled={videoSaving === lesson.id}
                                  className="block text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 disabled:opacity-50"
                                />
                              </div>
                              {selectedFiles[lesson.id] && (
                                <p className="text-sm text-muted-foreground">
                                  {selectedFiles[lesson.id]!.name}
                                  {uploadDurations[lesson.id] != null && ` (${uploadDurations[lesson.id]} 秒)`}
                                </p>
                              )}
                              {videoSaving === lesson.id && (uploadProgress[lesson.id] ?? 0) > 0 && (
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                                    <span>アップロード中...</span>
                                    <span>{uploadProgress[lesson.id]}%</span>
                                  </div>
                                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                                    <div
                                      className="h-full bg-primary transition-all duration-200"
                                      style={{ width: `${uploadProgress[lesson.id]}%` }}
                                    />
                                  </div>
                                </div>
                              )}
                              <Button
                                size="sm"
                                onClick={() => handleFileUpload(lesson.id)}
                                disabled={!selectedFiles[lesson.id] || videoSaving === lesson.id}
                              >
                                {videoSaving === lesson.id ? "アップロード中..." : "アップロード"}
                              </Button>
                            </>
                          ) : (
                            <>
                              <div className="space-y-1">
                                <label className="text-sm font-medium">Google Drive URL</label>
                                <Input
                                  value={vForm.driveUrl}
                                  onChange={(e) =>
                                    updateVideoForm(lesson.id, { driveUrl: e.target.value })
                                  }
                                  placeholder="https://drive.google.com/file/d/.../view"
                                />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                再生時間は動画ファイルから自動取得されます
                              </p>
                              {importStatus[lesson.id] && (
                                <div className={`text-sm ${
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
                              <Button
                                size="sm"
                                onClick={() => handleSaveVideo(lesson.id)}
                                disabled={videoSaving === lesson.id || !vForm.driveUrl}
                              >
                                {videoSaving === lesson.id
                                  ? "インポート中..."
                                  : "Google Driveからインポート"}
                              </Button>
                            </>
                          )}
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
                          <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setQuizGenDialog(lesson.id);
                              setQuizGenDocsUrl("");
                              setQuizGenError(null);
                            }}
                          >
                            Google Docsから生成
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setQuizImportDialog(lesson.id);
                              setQuizImportDocsUrl("");
                              setQuizImportError(null);
                              setQuizImportTabs(null);
                              setQuizImportSelectedTab(null);
                            }}
                          >
                            Docsからインポート
                          </Button>
                          </div>
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

      {/* Quiz Import Dialog */}
      <Dialog open={quizImportDialog !== null} onOpenChange={(open) => !open && setQuizImportDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Google Docsからインポート</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Google Docs URL</label>
              <Input
                value={quizImportDocsUrl}
                onChange={(e) => {
                  setQuizImportDocsUrl(e.target.value);
                  setQuizImportTabs(null);
                  setQuizImportSelectedTab(null);
                }}
                placeholder="https://docs.google.com/document/d/.../edit"
                disabled={quizImporting}
              />
            </div>

            {quizImportTabs && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  「テスト」タブが見つかりませんでした。インポート元のタブを選択してください。
                </p>
                <div className="space-y-1">
                  {quizImportTabs.map((tab) => (
                    <label key={tab.id} className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-muted">
                      <input
                        type="radio"
                        name="quizImportTabMaster"
                        value={tab.id}
                        checked={quizImportSelectedTab === tab.id}
                        onChange={() => setQuizImportSelectedTab(tab.id)}
                      />
                      <span className="text-sm">{tab.title}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {quizImportWarnings.length > 0 && (
              <div className="rounded-md bg-yellow-50 border border-yellow-200 p-3">
                {quizImportWarnings.map((w, i) => (
                  <p key={i} className="text-sm text-yellow-800">{w}</p>
                ))}
              </div>
            )}

            {quizImportError && (
              <div className="text-sm text-destructive">{quizImportError}</div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQuizImportDialog(null)}
              disabled={quizImporting}
            >
              キャンセル
            </Button>
            <Button
              onClick={() => quizImportDialog && handleImportQuiz(quizImportDialog)}
              disabled={!quizImportDocsUrl || quizImporting || (quizImportTabs !== null && !quizImportSelectedTab)}
            >
              {quizImporting ? "インポート中..." : quizImportTabs ? "選択してインポート" : "インポート"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quiz Generation Dialog */}
      <Dialog open={quizGenDialog !== null} onOpenChange={(open) => !open && setQuizGenDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Google Docsからクイズを生成</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Google Docs URL</label>
              <Input
                value={quizGenDocsUrl}
                onChange={(e) => setQuizGenDocsUrl(e.target.value)}
                placeholder="https://docs.google.com/document/d/.../edit"
                disabled={quizGenerating}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">問題数</label>
                <Input
                  type="number"
                  value={quizGenCount}
                  onChange={(e) => setQuizGenCount(e.target.value)}
                  min={1}
                  max={50}
                  disabled={quizGenerating}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">難易度</label>
                <Select
                  value={quizGenDifficulty}
                  onValueChange={setQuizGenDifficulty}
                  disabled={quizGenerating}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">基礎</SelectItem>
                    <SelectItem value="medium">標準</SelectItem>
                    <SelectItem value="hard">応用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {quizGenError && (
              <div className="text-sm text-destructive">{quizGenError}</div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQuizGenDialog(null)}
              disabled={quizGenerating}
            >
              キャンセル
            </Button>
            <Button
              onClick={() => quizGenDialog && handleGenerateQuiz(quizGenDialog)}
              disabled={!quizGenDocsUrl || quizGenerating}
            >
              {quizGenerating ? "生成中..." : "生成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
