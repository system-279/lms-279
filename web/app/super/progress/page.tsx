"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSuperAdminFetch } from "@/lib/super-api";
import type {
  SuperStudentProgressResponse,
  SuperCourseRecord,
  SuperLessonRecord,
} from "@lms-279/shared-types";

type Tenant = { id: string; name: string };
type CourseOption = { id: string; name: string };

export default function StudentProgressPage() {
  const { superFetch } = useSuperAdminFetch();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [selectedCourse, setSelectedCourse] = useState("");
  const [report, setReport] = useState<SuperStudentProgressResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 展開状態: "userId_courseId" → true
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 編集ダイアログ
  const [editOpen, setEditOpen] = useState(false);
  const [editContext, setEditContext] = useState<{
    userId: string;
    userName: string | null;
    lessonId: string;
    lessonTitle: string;
    lesson: SuperLessonRecord;
  } | null>(null);
  const [editVideoCompleted, setEditVideoCompleted] = useState(false);
  const [editQuizPassed, setEditQuizPassed] = useState(false);
  const [editQuizBestScore, setEditQuizBestScore] = useState("");
  const [editLessonCompleted, setEditLessonCompleted] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // スプレッドシート出力
  const [exportLoading, setExportLoading] = useState(false);

  // テナント一覧取得
  useEffect(() => {
    superFetch<{ tenants: Tenant[] }>("/api/v2/super/tenants?limit=100")
      .then((data) => setTenants(data.tenants))
      .catch((e) => {
        setTenants([]);
        setError(e instanceof Error ? e.message : "テナント一覧の取得に失敗しました");
      });
  }, [superFetch]);

  // テナント選択時に初回データ取得（コース一覧抽出 + レポート表示）
  useEffect(() => {
    if (!selectedTenant) {
      setCourses([]);
      setReport(null);
      return;
    }
    setLoading(true);
    setError(null);
    setExpanded({});
    superFetch<SuperStudentProgressResponse>(
      `/api/v2/super/tenants/${selectedTenant}/student-progress`
    )
      .then((data) => {
        // コース一覧をユニークに抽出
        const courseMap = new Map<string, string>();
        for (const student of data.students) {
          for (const course of student.courses) {
            courseMap.set(course.courseId, course.courseName);
          }
        }
        setCourses(Array.from(courseMap, ([id, name]) => ({ id, name })));
        setSelectedCourse("");
        setReport(data);
      })
      .catch((e) => {
        setCourses([]);
        setError(e instanceof Error ? e.message : "取得に失敗しました");
      })
      .finally(() => setLoading(false));
  }, [superFetch, selectedTenant]);

  const fetchReport = useCallback(async () => {
    if (!selectedTenant) return;
    setLoading(true);
    setError(null);
    setExpanded({});
    try {
      const qs = selectedCourse ? `?courseId=${selectedCourse}` : "";
      const data = await superFetch<SuperStudentProgressResponse>(
        `/api/v2/super/tenants/${selectedTenant}/student-progress${qs}`
      );
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [superFetch, selectedTenant, selectedCourse]);

  const toggleExpand = (userId: string, courseId: string) => {
    const key = `${userId}_${courseId}`;
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openEdit = (userId: string, userName: string | null, lesson: SuperLessonRecord) => {
    setEditContext({
      userId,
      userName,
      lessonId: lesson.lessonId,
      lessonTitle: lesson.lessonTitle,
      lesson,
    });
    setEditVideoCompleted(lesson.videoCompleted);
    setEditQuizPassed(lesson.quizPassed);
    setEditQuizBestScore(lesson.quizBestScore?.toString() ?? "");
    setEditLessonCompleted(lesson.lessonCompleted);
    setEditError(null);
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editContext || !selectedTenant) return;
    setEditLoading(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {
        videoCompleted: editVideoCompleted,
        quizPassed: editQuizPassed,
        lessonCompleted: editLessonCompleted,
      };
      if (editQuizBestScore !== "") {
        const score = Number(editQuizBestScore);
        if (isNaN(score) || score < 0 || score > 100) {
          setEditError("テスト最高点は0〜100の数値を入力してください");
          setEditLoading(false);
          return;
        }
        body.quizBestScore = score;
      }

      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/student-progress/${editContext.lessonId}/${editContext.userId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      setEditOpen(false);
      fetchReport();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  const handleExportSheets = async () => {
    if (!selectedTenant) return;
    setExportLoading(true);
    try {
      const body: Record<string, unknown> = {};
      if (selectedCourse) body.courseId = selectedCourse;

      const result = await superFetch<{ spreadsheetUrl: string }>(
        `/api/v2/super/tenants/${selectedTenant}/student-progress/export-sheets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      window.open(result.spreadsheetUrl, "_blank");
    } catch (e) {
      setError(e instanceof Error ? e.message : "スプレッドシート出力に失敗しました");
    } finally {
      setExportLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">受講状況管理</h1>

      {/* フィルタ */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label className="text-sm font-medium">テナント</label>
          <Select value={selectedTenant} onValueChange={setSelectedTenant}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="テナントを選択" />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">コース（任意）</label>
          <Select value={selectedCourse} onValueChange={setSelectedCourse}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="全コース" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">全コース</SelectItem>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={fetchReport} disabled={!selectedTenant || loading}>
          {loading ? "取得中..." : "表示"}
        </Button>
        {report && (
          <Button
            variant="outline"
            onClick={handleExportSheets}
            disabled={exportLoading}
          >
            {exportLoading ? "出力中..." : "スプレッドシート出力"}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* レポートテーブル */}
      {report && (
        <div>
          <p className="text-sm text-muted-foreground mb-2">
            {report.tenantName} — 受講生{report.totalStudents}名
          </p>

          {report.students.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-muted-foreground">
              データがありません
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>受講者</TableHead>
                    <TableHead>コース</TableHead>
                    <TableHead>進捗</TableHead>
                    <TableHead>進捗率</TableHead>
                    <TableHead>完了</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.students.flatMap((student) =>
                    student.courses.map((course: SuperCourseRecord) => {
                      const expandKey = `${student.userId}_${course.courseId}`;
                      const isExpanded = expanded[expandKey] ?? false;

                      return [
                        // コース行
                        <TableRow
                          key={expandKey}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => toggleExpand(student.userId, course.courseId)}
                        >
                          <TableCell className="text-center text-muted-foreground">
                            {isExpanded ? "▼" : "▶"}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">{student.userName ?? "—"}</div>
                            <div className="text-xs text-muted-foreground">{student.userEmail}</div>
                          </TableCell>
                          <TableCell>{course.courseName}</TableCell>
                          <TableCell>
                            {course.completedLessons}/{course.totalLessons}
                          </TableCell>
                          <TableCell>
                            {(course.progressRatio * 100).toFixed(0)}%
                          </TableCell>
                          <TableCell>
                            {course.isCompleted ? (
                              <span className="text-green-600 font-medium">完了</span>
                            ) : (
                              <span className="text-muted-foreground">未完了</span>
                            )}
                          </TableCell>
                        </TableRow>,

                        // 展開レッスン行
                        ...(isExpanded
                          ? course.lessons.map((lesson: SuperLessonRecord) => (
                              <TableRow
                                key={`${expandKey}_${lesson.lessonId}`}
                                className="bg-muted/30"
                              >
                                <TableCell></TableCell>
                                <TableCell className="pl-8 text-sm text-muted-foreground">
                                  └ {lesson.lessonTitle}
                                </TableCell>
                                <TableCell>
                                  <span className={lesson.videoCompleted ? "text-green-600" : "text-muted-foreground"}>
                                    動画: {lesson.videoCompleted ? "完了" : "未完了"}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  <span className={lesson.quizPassed ? "text-green-600" : "text-muted-foreground"}>
                                    テスト: {lesson.quizPassed ? "合格" : "未合格"}
                                  </span>
                                  {lesson.quizBestScore !== null && (
                                    <span className="text-xs ml-1">({lesson.quizBestScore}点)</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {lesson.lessonCompleted ? (
                                    <span className="text-green-600 font-medium">完了</span>
                                  ) : (
                                    <span className="text-muted-foreground">未完了</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openEdit(student.userId, student.userName, lesson);
                                    }}
                                  >
                                    編集
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          : []),
                      ];
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* 編集ダイアログ */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レッスン進捗を編集</DialogTitle>
            <DialogDescription>
              {editContext?.userName ?? "受講者"} — {editContext?.lessonTitle}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={editVideoCompleted}
                onChange={(e) => setEditVideoCompleted(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm font-medium">動画完了</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={editQuizPassed}
                onChange={(e) => setEditQuizPassed(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm font-medium">テスト合格</span>
            </label>
            <div className="space-y-1">
              <label className="text-sm font-medium">テスト最高点</label>
              <Input
                type="number"
                min="0"
                max="100"
                value={editQuizBestScore}
                onChange={(e) => setEditQuizBestScore(e.target.value)}
                placeholder="未受験の場合は空"
              />
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={editLessonCompleted}
                onChange={(e) => setEditLessonCompleted(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm font-medium">レッスン完了</span>
            </label>
            {editError && (
              <div className="text-sm text-destructive">{editError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleEdit} disabled={editLoading}>
              {editLoading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
