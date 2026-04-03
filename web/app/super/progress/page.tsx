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
  const [editDate, setEditDate] = useState("");
  const [editEntryTime, setEditEntryTime] = useState("");
  const [editExitTime, setEditExitTime] = useState("");
  const [editExitReason, setEditExitReason] = useState("");
  const [editQuizScore, setEditQuizScore] = useState("");
  const [editQuizPassed, setEditQuizPassed] = useState(false);
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
      const courseId = selectedCourse && selectedCourse !== "__all__" ? selectedCourse : "";
      const qs = courseId ? `?courseId=${courseId}` : "";
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

  const toJstDateAndTime = (iso: string | null): { date: string; time: string } => {
    if (!iso) return { date: "", time: "" };
    const d = new Date(iso);
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return {
      date: jst.toISOString().slice(0, 10),
      time: jst.toISOString().slice(11, 16),
    };
  };

  const openEdit = (userId: string, userName: string | null, lesson: SuperLessonRecord) => {
    setEditContext({
      userId,
      userName,
      lessonId: lesson.lessonId,
      lessonTitle: lesson.lessonTitle,
      lesson,
    });
    const entry = toJstDateAndTime(lesson.latestEntryAt);
    const exit = toJstDateAndTime(lesson.latestExitAt);
    setEditDate(entry.date);
    setEditEntryTime(entry.time);
    setEditExitTime(exit.time);
    setEditExitReason(lesson.latestExitReason ?? "");
    setEditQuizScore(lesson.quizBestScore?.toString() ?? "");
    setEditQuizPassed(lesson.quizPassed);
    setEditError(null);
    setEditOpen(true);
  };

  const jstToUtcIso = (date: string, time: string): string => {
    const jstDate = new Date(`${date}T${time}:00+09:00`);
    return jstDate.toISOString();
  };

  const handleEdit = async () => {
    if (!editContext || !selectedTenant) return;
    const sessionId = editContext.lesson.latestSessionId;
    if (!sessionId) {
      setEditError("このレッスンにはセッション記録がありません");
      return;
    }
    setEditLoading(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {};

      if (editDate && editEntryTime) {
        body.entryAt = jstToUtcIso(editDate, editEntryTime);
      }
      if (editDate && editExitTime) {
        body.exitAt = jstToUtcIso(editDate, editExitTime);
      }
      if (editExitReason) {
        body.exitReason = editExitReason;
      }
      if (editQuizScore !== "") {
        const score = Number(editQuizScore);
        if (isNaN(score) || score < 0 || score > 100) {
          setEditError("テスト点数は0〜100の数値を入力してください");
          setEditLoading(false);
          return;
        }
        body.quizScore = score;
      }
      body.quizPassed = editQuizPassed;

      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/attendance-report/${sessionId}`,
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
              <SelectItem value="__all__">全コース</SelectItem>
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
                    <TableHead>入退室</TableHead>
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
                          <TableCell></TableCell>
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
                                  <div className="text-xs space-y-0.5">
                                    <div>
                                      入室: {lesson.latestEntryAt
                                        ? new Date(lesson.latestEntryAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
                                        : "—"}
                                    </div>
                                    <div>
                                      退室: {lesson.latestExitAt
                                        ? new Date(lesson.latestExitAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
                                        : "—"}
                                    </div>
                                  </div>
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
            <div className="space-y-1">
              <label className="text-sm font-medium">日付</label>
              <Input
                type="date"
                value={editDate}
                onChange={(e) => setEditDate(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">入室</label>
                <Input
                  type="time"
                  value={editEntryTime}
                  onChange={(e) => setEditEntryTime(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">退室</label>
                <Input
                  type="time"
                  value={editExitTime}
                  onChange={(e) => setEditExitTime(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">退室理由</label>
              <Select value={editExitReason} onValueChange={setEditExitReason}>
                <SelectTrigger>
                  <SelectValue placeholder="未設定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quiz_submitted">テスト送信</SelectItem>
                  <SelectItem value="pause_timeout">一時停止タイムアウト</SelectItem>
                  <SelectItem value="time_limit">時間制限</SelectItem>
                  <SelectItem value="browser_close">ブラウザ終了</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">テスト点数</label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={editQuizScore}
                  onChange={(e) => setEditQuizScore(e.target.value)}
                  placeholder="未受験の場合は空"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">合否</label>
                <Select
                  value={editQuizPassed ? "passed" : "failed"}
                  onValueChange={(v) => setEditQuizPassed(v === "passed")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="passed">合格</SelectItem>
                    <SelectItem value="failed">不合格</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
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
