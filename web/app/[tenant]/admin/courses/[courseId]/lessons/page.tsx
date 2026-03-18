"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthenticatedFetch } from "@/lib/hooks/use-authenticated-fetch";
import { useTenant } from "@/lib/tenant-context";

type Lesson = {
  id: string;
  title: string;
  order: number;
  hasVideo: boolean;
  hasQuiz: boolean;
};

type Course = {
  id: string;
  name: string;
  description: string;
  status: string;
};

export default function LessonsPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const { tenantId } = useTenant();
  const { authFetch } = useAuthenticatedFetch();

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingLesson, setDeletingLesson] = useState<Lesson | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [courseData, lessonsData] = await Promise.all([
        authFetch<{ course: Course }>(`/api/v1/admin/courses/${courseId}`),
        authFetch<{ lessons: Lesson[] }>(`/api/v1/admin/courses/${courseId}/lessons`),
      ]);
      setCourse(courseData.course);
      const sorted = [...lessonsData.lessons].sort((a, b) => a.order - b.order);
      setLessons(sorted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [authFetch, courseId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreate = async () => {
    if (!createTitle.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await authFetch(`/api/v1/admin/courses/${courseId}/lessons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: createTitle.trim() }),
      });
      setCreateOpen(false);
      setCreateTitle("");
      fetchData();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreateLoading(false);
    }
  };

  const openEdit = (lesson: Lesson) => {
    setEditingLesson(lesson);
    setEditTitle(lesson.title);
    setEditError(null);
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editingLesson || !editTitle.trim()) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await authFetch(`/api/v1/admin/courses/${courseId}/lessons/${editingLesson.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle.trim() }),
      });
      setEditOpen(false);
      setEditingLesson(null);
      fetchData();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  const openDelete = (lesson: Lesson) => {
    setDeletingLesson(lesson);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingLesson) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await authFetch(`/api/v1/admin/courses/${courseId}/lessons/${deletingLesson.id}`, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      setDeletingLesson(null);
      fetchData();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleReorder = async (lessonId: string, direction: "up" | "down") => {
    const index = lessons.findIndex((l) => l.id === lessonId);
    if (index === -1) return;
    if (direction === "up" && index === 0) return;
    if (direction === "down" && index === lessons.length - 1) return;

    const newLessons = [...lessons];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    [newLessons[index], newLessons[swapIndex]] = [newLessons[swapIndex], newLessons[index]];
    setLessons(newLessons);

    try {
      await authFetch(`/api/v1/admin/courses/${courseId}/lessons/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonIds: newLessons.map((l) => l.id) }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "並び替えに失敗しました");
      fetchData();
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={`/${tenantId}/admin/courses`} className="hover:text-foreground">
          講座管理
        </Link>
        <span>/</span>
        <span className="text-foreground">{course?.name ?? "読み込み中..."}</span>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">レッスン管理</h1>
          {course && (
            <p className="text-sm text-muted-foreground mt-1">{course.name}</p>
          )}
        </div>
        <Button
          onClick={() => { setCreateTitle(""); setCreateError(null); setCreateOpen(true); }}
        >
          新規作成
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : lessons.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          データがありません
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>順序</TableHead>
              <TableHead>タイトル</TableHead>
              <TableHead>動画</TableHead>
              <TableHead>テスト</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lessons.map((lesson, index) => (
              <TableRow key={lesson.id}>
                <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="font-medium">{lesson.title}</TableCell>
                <TableCell>{lesson.hasVideo ? "あり" : "なし"}</TableCell>
                <TableCell>{lesson.hasQuiz ? "あり" : "なし"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReorder(lesson.id, "up")}
                      disabled={index === 0}
                    >
                      上へ
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReorder(lesson.id, "down")}
                      disabled={index === lessons.length - 1}
                    >
                      下へ
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openEdit(lesson)}>
                      編集
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => openDelete(lesson)}
                    >
                      削除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* 作成ダイアログ */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レッスンを作成</DialogTitle>
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
            <Button onClick={handleCreate} disabled={createLoading || !createTitle.trim()}>
              {createLoading ? "作成中..." : "作成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 編集ダイアログ */}
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
            <Button onClick={handleEdit} disabled={editLoading || !editTitle.trim()}>
              {editLoading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レッスンを削除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「{deletingLesson?.title}」を削除しますか？この操作は取り消せません。
          </p>
          {deleteError && (
            <div className="text-sm text-destructive">{deleteError}</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              キャンセル
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading ? "削除中..." : "削除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
