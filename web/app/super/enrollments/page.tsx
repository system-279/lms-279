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
import { addMonths, addYears } from "date-fns";
import { useSuperAdminFetch } from "@/lib/super-api";
import type { CourseEnrollmentSettingResponse } from "@lms-279/shared-types";

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
  const [settings, setSettings] = useState<CourseEnrollmentSettingResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 設定ダイアログ
  const [settingOpen, setSettingOpen] = useState(false);
  const [settingCourseId, setSettingCourseId] = useState("");
  const [settingCourseName, setSettingCourseName] = useState("");
  const [settingEnrolledAt, setSettingEnrolledAt] = useState("");
  const [settingLoading, setSettingLoading] = useState(false);

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
        const res = await superFetch<{ courses: Course[] }>(
          `/api/v2/${selectedTenant}/courses`
        );
        setCourses(Array.isArray(res.courses) ? res.courses : []);
      })
      .catch(() => setCourses([]));
  }, [selectedTenant, superFetch]);

  // 設定一覧取得
  const fetchSettings = useCallback(async () => {
    if (!selectedTenant) return;
    setLoading(true);
    setError(null);
    try {
      const data = await superFetch<{ settings: CourseEnrollmentSettingResponse[] }>(
        `/api/v2/super/tenants/${selectedTenant}/course-settings`
      );
      setSettings(data.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [selectedTenant, superFetch]);

  useEffect(() => {
    if (selectedTenant) {
      fetchSettings();
    }
  }, [selectedTenant, fetchSettings]);

  // コース名マップ
  const courseNameMap = new Map(courses.map((c) => [c.id, c.name]));

  // 設定保存
  const handleSave = async () => {
    if (!selectedTenant || !settingCourseId || !settingEnrolledAt) return;
    setSettingLoading(true);
    try {
      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/course-settings/${settingCourseId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enrolledAt: new Date(settingEnrolledAt).toISOString(),
          }),
        }
      );
      setSettingOpen(false);
      fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSettingLoading(false);
    }
  };

  // 設定削除
  const handleDelete = async (courseId: string) => {
    const courseName = courseNameMap.get(courseId) ?? courseId;
    if (!confirm(`${courseName} の受講期間設定を削除しますか？\n削除するとこのコースの受講期間制限が解除されます。`)) return;
    try {
      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/course-settings/${courseId}`,
        { method: "DELETE" }
      );
      fetchSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  // 設定ダイアログを開く
  const openSettingDialog = (courseId: string, courseName: string, currentEnrolledAt?: string) => {
    setSettingCourseId(courseId);
    setSettingCourseName(courseName);
    setSettingEnrolledAt(currentEnrolledAt?.split("T")[0] ?? "");
    setSettingOpen(true);
  };

  // 未設定コース
  const settingCourseIds = new Set(settings.map((s) => s.courseId));
  const unconfiguredCourses = courses.filter((c) => !settingCourseIds.has(c.id));

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">受講期間管理</h2>
      <p className="text-sm text-muted-foreground">
        テナント×コース単位で受講期間を設定します。テスト期限（+2ヶ月）と動画期限（+1年）は受講開始日から自動計算されます。
      </p>

      {/* テナント選択 */}
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

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* 設定済みコース一覧 */}
      {loading ? (
        <p className="text-muted-foreground">読み込み中...</p>
      ) : !selectedTenant ? (
        <p className="text-muted-foreground">テナントを選択してください</p>
      ) : (
        <>
          {settings.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>コース</TableHead>
                  <TableHead>受講開始日</TableHead>
                  <TableHead>テスト期限</TableHead>
                  <TableHead>動画期限</TableHead>
                  <TableHead>設定者</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.map((s) => (
                  <TableRow key={s.courseId}>
                    <TableCell>{courseNameMap.get(s.courseId) ?? s.courseId}</TableCell>
                    <TableCell>{formatDate(s.enrolledAt)}</TableCell>
                    <TableCell>
                      <span className={isExpired(s.quizAccessUntil) ? "text-destructive font-medium" : ""}>
                        {formatDate(s.quizAccessUntil)}
                        {isExpired(s.quizAccessUntil) && " (期限切れ)"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={isExpired(s.videoAccessUntil) ? "text-destructive font-medium" : ""}>
                        {formatDate(s.videoAccessUntil)}
                        {isExpired(s.videoAccessUntil) && " (期限切れ)"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{s.createdBy}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openSettingDialog(
                            s.courseId,
                            courseNameMap.get(s.courseId) ?? s.courseId,
                            s.enrolledAt
                          )}
                        >
                          変更
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => handleDelete(s.courseId)}
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

          {settings.length === 0 && (
            <p className="text-muted-foreground">受講期間の設定がありません</p>
          )}

          {/* 未設定コース一覧 */}
          {unconfiguredCourses.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">未設定のコース</h3>
              <div className="flex flex-wrap gap-2">
                {unconfiguredCourses.map((c) => (
                  <Button
                    key={c.id}
                    variant="outline"
                    size="sm"
                    onClick={() => openSettingDialog(c.id, c.name)}
                  >
                    {c.name} — 期間を設定
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* 設定ダイアログ */}
      <Dialog open={settingOpen} onOpenChange={setSettingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>受講期間を設定</DialogTitle>
            <DialogDescription>
              {settingCourseName} の受講開始日を設定します。テスト期限（+2ヶ月）と動画期限（+1年）は自動計算されます。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm">受講開始日</label>
              <Input
                type="date"
                value={settingEnrolledAt}
                onChange={(e) => setSettingEnrolledAt(e.target.value)}
              />
            </div>
            {/* プレビュー: date-fnsで計算。formatDateは日付のみ表示なのでendOfDayUTC不要（BEは日末T23:59:59.999Zで保存） */}
            {settingEnrolledAt && !isNaN(new Date(settingEnrolledAt).getTime()) && (
              <div className="text-sm text-muted-foreground space-y-1">
                <p>テスト期限: {formatDate(addMonths(new Date(settingEnrolledAt), 2).toISOString())}（この日の終わりまで有効）</p>
                <p>動画期限: {formatDate(addYears(new Date(settingEnrolledAt), 1).toISOString())}（この日の終わりまで有効）</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingOpen(false)}>キャンセル</Button>
            <Button onClick={handleSave} disabled={settingLoading || !settingEnrolledAt}>
              {settingLoading ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
