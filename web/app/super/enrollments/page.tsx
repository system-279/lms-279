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
import type { EnrollmentResponse } from "@lms-279/shared-types";

type Tenant = { id: string; name: string };
type Course = { id: string; name: string };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function isExpired(dateStr: string): boolean {
  return new Date(dateStr) < new Date();
}

export default function EnrollmentsPage() {
  const { superFetch } = useSuperAdminFetch();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const ALL_COURSES = "__all__";
  const [selectedCourse, setSelectedCourse] = useState(ALL_COURSES);
  const [enrollments, setEnrollments] = useState<EnrollmentResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 新規作成ダイアログ
  const [createOpen, setCreateOpen] = useState(false);
  const [createUserId, setCreateUserId] = useState("");
  const [createEnrolledAt, setCreateEnrolledAt] = useState("");
  const [createLoading, setCreateLoading] = useState(false);

  // 一括作成ダイアログ
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkUserIds, setBulkUserIds] = useState("");
  const [bulkEnrolledAt, setBulkEnrolledAt] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);

  // 編集ダイアログ
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EnrollmentResponse | null>(null);
  const [editQuizUntil, setEditQuizUntil] = useState("");
  const [editVideoUntil, setEditVideoUntil] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // テナント一覧取得
  useEffect(() => {
    superFetch<{ tenants: Tenant[] }>("/api/v2/super/tenants?limit=100")
      .then((data) => setTenants(data.tenants))
      .catch(() => {});
  }, [superFetch]);

  // コース一覧取得（テナント選択時）
  useEffect(() => {
    if (!selectedTenant) {
      setCourses([]);
      return;
    }
    superFetch<{ tenants: Tenant[] }>(`/api/v2/super/tenants/${selectedTenant}`)
      .then(async () => {
        // テナントのコース一覧は共有ルート経由で取得
        const res = await superFetch<{ courses: Course[] }>(
          `/api/v2/${selectedTenant}/courses`
        );
        setCourses(Array.isArray(res.courses) ? res.courses : []);
      })
      .catch(() => setCourses([]));
  }, [selectedTenant, superFetch]);

  // enrollment一覧取得
  const fetchEnrollments = useCallback(async () => {
    if (!selectedTenant) return;
    setLoading(true);
    setError(null);
    try {
      const query = selectedCourse !== ALL_COURSES ? `?courseId=${selectedCourse}` : "";
      const data = await superFetch<{ enrollments: EnrollmentResponse[] }>(
        `/api/v2/super/tenants/${selectedTenant}/enrollments${query}`
      );
      setEnrollments(data.enrollments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedTenant, selectedCourse, superFetch]);

  useEffect(() => {
    if (selectedTenant) {
      fetchEnrollments();
    }
  }, [selectedTenant, selectedCourse, fetchEnrollments]);

  // 新規作成
  const handleCreate = async () => {
    if (!selectedTenant || selectedCourse === ALL_COURSES || !createUserId || !createEnrolledAt) return;
    setCreateLoading(true);
    try {
      await superFetch(`/api/v2/super/tenants/${selectedTenant}/enrollments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: createUserId,
          courseId: selectedCourse,
          enrolledAt: new Date(createEnrolledAt).toISOString(),
        }),
      });
      setCreateOpen(false);
      setCreateUserId("");
      setCreateEnrolledAt("");
      fetchEnrollments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "作成に失敗しました");
    } finally {
      setCreateLoading(false);
    }
  };

  // 一括作成
  const handleBulkCreate = async () => {
    if (!selectedTenant || selectedCourse === ALL_COURSES || !bulkUserIds || !bulkEnrolledAt) return;
    setBulkLoading(true);
    try {
      const userIds = bulkUserIds
        .split("\n")
        .map((id) => id.trim())
        .filter(Boolean);
      await superFetch(`/api/v2/super/tenants/${selectedTenant}/enrollments/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds,
          courseId: selectedCourse,
          enrolledAt: new Date(bulkEnrolledAt).toISOString(),
        }),
      });
      setBulkOpen(false);
      setBulkUserIds("");
      setBulkEnrolledAt("");
      fetchEnrollments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "一括作成に失敗しました");
    } finally {
      setBulkLoading(false);
    }
  };

  // 期限更新
  const handleEdit = async () => {
    if (!editTarget || !selectedTenant) return;
    setEditLoading(true);
    try {
      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/enrollments/${editTarget.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(editQuizUntil && { quizAccessUntil: new Date(editQuizUntil).toISOString() }),
            ...(editVideoUntil && { videoAccessUntil: new Date(editVideoUntil).toISOString() }),
          }),
        }
      );
      setEditOpen(false);
      setEditTarget(null);
      fetchEnrollments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  // 削除
  const handleDelete = async (enrollment: EnrollmentResponse) => {
    if (!confirm(`${enrollment.userId} の受講期間設定を削除しますか？`)) return;
    try {
      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/enrollments/${enrollment.id}`,
        { method: "DELETE" }
      );
      fetchEnrollments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">受講期間管理</h2>

      {/* フィルタ */}
      <div className="flex gap-4 items-end flex-wrap">
        <div className="w-64">
          <label className="text-sm text-muted-foreground">テナント</label>
          <Select value={selectedTenant} onValueChange={setSelectedTenant}>
            <SelectTrigger><SelectValue placeholder="テナント選択" /></SelectTrigger>
            <SelectContent>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-64">
          <label className="text-sm text-muted-foreground">コース</label>
          <Select value={selectedCourse} onValueChange={setSelectedCourse} disabled={!selectedTenant}>
            <SelectTrigger><SelectValue placeholder="全コース" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_COURSES}>全コース</SelectItem>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selectedTenant && selectedCourse !== ALL_COURSES && (
          <div className="flex gap-2">
            <Button onClick={() => setCreateOpen(true)}>新規登録</Button>
            <Button variant="outline" onClick={() => setBulkOpen(true)}>一括登録</Button>
          </div>
        )}
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* テーブル */}
      {loading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : enrollments.length === 0 ? (
        selectedTenant ? (
          <p className="text-muted-foreground">受講期間の登録がありません</p>
        ) : (
          <p className="text-muted-foreground">テナントを選択してください</p>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ユーザーID</TableHead>
              <TableHead>コースID</TableHead>
              <TableHead>受講開始日</TableHead>
              <TableHead>テスト期限</TableHead>
              <TableHead>動画期限</TableHead>
              <TableHead>設定者</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {enrollments.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-xs">{e.userId}</TableCell>
                <TableCell className="font-mono text-xs">{e.courseId}</TableCell>
                <TableCell>{formatDate(e.enrolledAt)}</TableCell>
                <TableCell>
                  <span className={isExpired(e.quizAccessUntil) ? "text-destructive font-medium" : ""}>
                    {formatDate(e.quizAccessUntil)}
                    {isExpired(e.quizAccessUntil) && " (期限切れ)"}
                  </span>
                </TableCell>
                <TableCell>
                  <span className={isExpired(e.videoAccessUntil) ? "text-destructive font-medium" : ""}>
                    {formatDate(e.videoAccessUntil)}
                    {isExpired(e.videoAccessUntil) && " (期限切れ)"}
                  </span>
                </TableCell>
                <TableCell className="text-xs">{e.createdBy}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditTarget(e);
                        setEditQuizUntil(e.quizAccessUntil?.split("T")[0] ?? "");
                        setEditVideoUntil(e.videoAccessUntil?.split("T")[0] ?? "");
                        setEditOpen(true);
                      }}
                    >
                      延長
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => handleDelete(e)}
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

      {/* 新規作成ダイアログ */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>受講期間を登録</DialogTitle>
            <DialogDescription>
              受講開始日を設定するとテスト期限（+2ヶ月）と動画期限（+1年）が自動計算されます
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm">ユーザーID</label>
              <Input
                value={createUserId}
                onChange={(e) => setCreateUserId(e.target.value)}
                placeholder="ユーザーIDを入力"
              />
            </div>
            <div>
              <label className="text-sm">受講開始日</label>
              <Input
                type="date"
                value={createEnrolledAt}
                onChange={(e) => setCreateEnrolledAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>キャンセル</Button>
            <Button onClick={handleCreate} disabled={createLoading || !createUserId || !createEnrolledAt}>
              {createLoading ? "作成中..." : "登録"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一括作成ダイアログ */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一括登録</DialogTitle>
            <DialogDescription>
              複数のユーザーIDを改行区切りで入力してください
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm">ユーザーID（改行区切り）</label>
              <textarea
                className="w-full h-32 border rounded-md p-2 text-sm font-mono"
                value={bulkUserIds}
                onChange={(e) => setBulkUserIds(e.target.value)}
                placeholder={"user1\nuser2\nuser3"}
              />
            </div>
            <div>
              <label className="text-sm">受講開始日</label>
              <Input
                type="date"
                value={bulkEnrolledAt}
                onChange={(e) => setBulkEnrolledAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>キャンセル</Button>
            <Button onClick={handleBulkCreate} disabled={bulkLoading || !bulkUserIds || !bulkEnrolledAt}>
              {bulkLoading ? "作成中..." : "一括登録"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 期限延長ダイアログ */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>受講期限を変更</DialogTitle>
            <DialogDescription>
              {editTarget?.userId} の期限を変更します
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm">テスト受験期限</label>
              <Input
                type="date"
                value={editQuizUntil}
                onChange={(e) => setEditQuizUntil(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm">動画視聴期限</label>
              <Input
                type="date"
                value={editVideoUntil}
                onChange={(e) => setEditVideoUntil(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>キャンセル</Button>
            <Button onClick={handleEdit} disabled={editLoading}>
              {editLoading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
