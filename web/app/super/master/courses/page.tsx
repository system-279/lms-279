"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSuperAdminFetch } from "@/lib/super-api";

type CourseStatus = "draft" | "published" | "archived";

type Course = {
  id: string;
  name: string;
  description: string | null;
  status: CourseStatus;
  lessonOrder: string[];
  passThreshold: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function StatusBadge({ status }: { status: CourseStatus }) {
  if (status === "published") {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200">
        公開中
      </Badge>
    );
  }
  if (status === "archived") {
    return (
      <Badge className="bg-red-100 text-red-800 border-red-200">
        アーカイブ
      </Badge>
    );
  }
  return <Badge variant="secondary">下書き</Badge>;
}

export default function MasterCoursesPage() {
  const { superFetch } = useSuperAdminFetch();

  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingCourse, setDeletingCourse] = useState<Course | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchCourses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const data = await superFetch<{ courses: Course[] }>(
        `/api/v2/super/master/courses${query}`,
      );
      setCourses(data.courses);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "マスターコースの取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [superFetch, statusFilter]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      await superFetch("/api/v2/super/master/courses", {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          description: createDescription.trim() || null,
        }),
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      fetchCourses();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreateLoading(false);
    }
  };

  const openEdit = (course: Course) => {
    setEditingCourse(course);
    setEditName(course.name);
    setEditDescription(course.description ?? "");
    setEditError(null);
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editingCourse || !editName.trim()) return;
    setEditLoading(true);
    setEditError(null);
    try {
      await superFetch(
        `/api/v2/super/master/courses/${editingCourse.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: editName.trim(),
            description: editDescription.trim() || null,
          }),
        },
      );
      setEditOpen(false);
      setEditingCourse(null);
      fetchCourses();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  const openDelete = (course: Course) => {
    setDeletingCourse(course);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingCourse) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await superFetch(
        `/api/v2/super/master/courses/${deletingCourse.id}`,
        { method: "DELETE" },
      );
      setDeleteOpen(false);
      setDeletingCourse(null);
      fetchCourses();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleteLoading(false);
    }
  };

  const handlePublish = async (course: Course) => {
    try {
      await superFetch(
        `/api/v2/super/master/courses/${course.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "published" }),
        },
      );
      fetchCourses();
    } catch (e) {
      setError(e instanceof Error ? e.message : "公開に失敗しました");
    }
  };

  const handleArchive = async (course: Course) => {
    try {
      await superFetch(
        `/api/v2/super/master/courses/${course.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "archived" }),
        },
      );
      fetchCourses();
    } catch (e) {
      setError(e instanceof Error ? e.message : "アーカイブに失敗しました");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">マスターコース管理</h1>
        <Button
          onClick={() => {
            setCreateName("");
            setCreateDescription("");
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          新規作成
        </Button>
      </div>

      {/* ステータスフィルタ */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">ステータス:</span>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">すべて</SelectItem>
            <SelectItem value="draft">下書き</SelectItem>
            <SelectItem value="published">公開中</SelectItem>
            <SelectItem value="archived">アーカイブ</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">読み込み中...</div>
      ) : courses.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          データがありません
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>コース名</TableHead>
              <TableHead>ステータス</TableHead>
              <TableHead>レッスン数</TableHead>
              <TableHead>作成日</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.map((course) => (
              <TableRow key={course.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/super/master/courses/${course.id}`}
                    className="hover:underline"
                  >
                    {course.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status={course.status} />
                </TableCell>
                <TableCell>{course.lessonOrder?.length ?? 0}</TableCell>
                <TableCell>
                  {new Date(course.createdAt).toLocaleDateString("ja-JP")}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/super/master/courses/${course.id}`}>
                      <Button variant="outline" size="sm">
                        詳細
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(course)}
                    >
                      編集
                    </Button>
                    {course.status !== "published" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePublish(course)}
                      >
                        公開
                      </Button>
                    )}
                    {course.status !== "archived" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleArchive(course)}
                      >
                        アーカイブ
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => openDelete(course)}
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
            <DialogTitle>マスターコースを作成</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">名前</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="コース名を入力"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">説明</label>
              <Textarea
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="コースの説明を入力"
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
              onClick={handleCreate}
              disabled={createLoading || !createName.trim()}
            >
              {createLoading ? "作成中..." : "作成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 編集ダイアログ */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>マスターコースを編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">名前</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="コース名を入力"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">説明</label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="コースの説明を入力"
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
              onClick={handleEdit}
              disabled={editLoading || !editName.trim()}
            >
              {editLoading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>マスターコースを削除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            「{deletingCourse?.name}
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
              onClick={handleDelete}
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
