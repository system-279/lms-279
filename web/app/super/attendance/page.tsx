"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isoToDatetimeLocal, datetimeLocalToISO } from "@/lib/tz-helpers";
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
  SuperAttendanceRecord,
  SuperAttendanceResponse,
} from "@lms-279/shared-types";

type Tenant = { id: string; name: string };

type SortDir = "asc" | "desc" | null;
type SortKey = keyof SuperAttendanceRecord;

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

const EXIT_REASON_LABELS: Record<string, string> = {
  quiz_submitted: "テスト合格",
  pause_timeout: "一時停止超過",
  time_limit: "時間制限",
  browser_close: "ブラウザ終了",
  max_attempts_failed: "受験上限(不合格)",
};

function SortIcon({ dir }: { dir: SortDir }) {
  if (dir === "asc") return <span className="ml-1">▲</span>;
  if (dir === "desc") return <span className="ml-1">▼</span>;
  return <span className="ml-1 text-muted-foreground/30">⇅</span>;
}

export default function AttendanceReportPage() {
  const { superFetch } = useSuperAdminFetch();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [report, setReport] = useState<SuperAttendanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // フィルター
  const [filterUser, setFilterUser] = useState("");
  const [filterCourse, setFilterCourse] = useState("");
  const [filterLesson, setFilterLesson] = useState("");
  const [filterExitReason, setFilterExitReason] = useState("");
  const [filterQuizPassed, setFilterQuizPassed] = useState("");

  // ソート
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  // 編集ダイアログ
  const [editOpen, setEditOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<SuperAttendanceRecord | null>(null);
  const [editEntryAt, setEditEntryAt] = useState("");
  const [editExitAt, setEditExitAt] = useState("");
  const [editScore, setEditScore] = useState("");
  const [editPassed, setEditPassed] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const tableRef = useRef<HTMLDivElement>(null);

  // テナント一覧取得
  useEffect(() => {
    superFetch<{ tenants: Tenant[] }>("/api/v2/super/tenants?limit=100")
      .then((data) => setTenants(data.tenants))
      .catch(() => setTenants([]));
  }, [superFetch]);

  // テナント選択時にデータ取得
  const fetchReport = useCallback(async () => {
    if (!selectedTenant) return;
    setLoading(true);
    setError(null);
    try {
      const data = await superFetch<SuperAttendanceResponse>(
        `/api/v2/super/tenants/${selectedTenant}/attendance-report`
      );
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [superFetch, selectedTenant]);

  useEffect(() => {
    if (selectedTenant) {
      fetchReport();
      // フィルター・ソートをリセット
      setFilterUser("");
      setFilterCourse("");
      setFilterLesson("");
      setFilterExitReason("");
      setFilterQuizPassed("");
      setSortKey(null);
      setSortDir(null);
    } else {
      setReport(null);
    }
  }, [selectedTenant, fetchReport]);

  // ソートトグル
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === "asc") setSortDir("desc");
      else if (sortDir === "desc") { setSortKey(null); setSortDir(null); }
      else setSortDir("asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // コース一覧（フィルタ用）
  const courseOptions = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, string>();
    for (const r of report.records) {
      if (r.courseId) map.set(r.courseId, r.courseName);
    }
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [report]);

  // フィルタ＋ソート適用
  const filteredRecords = useMemo(() => {
    if (!report) return [];
    let records = report.records;

    // フィルタ
    if (filterUser) {
      const q = filterUser.toLowerCase();
      records = records.filter(
        (r) =>
          (r.userName ?? "").toLowerCase().includes(q) ||
          (r.userEmail ?? "").toLowerCase().includes(q)
      );
    }
    if (filterCourse) {
      records = records.filter((r) => r.courseId === filterCourse);
    }
    if (filterLesson) {
      const q = filterLesson.toLowerCase();
      records = records.filter((r) => r.lessonTitle.toLowerCase().includes(q));
    }
    if (filterExitReason) {
      records = records.filter((r) => r.exitReason === filterExitReason);
    }
    if (filterQuizPassed === "passed") {
      records = records.filter((r) => r.quizPassed === true);
    } else if (filterQuizPassed === "failed") {
      records = records.filter((r) => r.quizPassed === false);
    } else if (filterQuizPassed === "none") {
      records = records.filter((r) => r.quizPassed === null);
    }

    // ソート
    if (sortKey && sortDir) {
      const dir = sortDir === "asc" ? 1 : -1;
      records = [...records].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        if (typeof av === "boolean" && typeof bv === "boolean") return (Number(av) - Number(bv)) * dir;
        return String(av).localeCompare(String(bv), "ja") * dir;
      });
    }

    return records;
  }, [report, filterUser, filterCourse, filterLesson, filterExitReason, filterQuizPassed, sortKey, sortDir]);

  const openEdit = (record: SuperAttendanceRecord) => {
    setEditRecord(record);
    setEditEntryAt(isoToDatetimeLocal(record.entryAt));
    setEditExitAt(isoToDatetimeLocal(record.exitAt));
    setEditScore(record.quizScore?.toString() ?? "");
    setEditPassed(record.quizPassed === null ? "" : record.quizPassed ? "true" : "false");
    setEditError(null);
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editRecord || !selectedTenant) return;
    setEditLoading(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {};
      if (editEntryAt) body.entryAt = datetimeLocalToISO(editEntryAt);
      if (editExitAt) body.exitAt = datetimeLocalToISO(editExitAt);
      if (editScore !== "") body.quizScore = Number(editScore);
      if (editPassed !== "") body.quizPassed = editPassed === "true";

      await superFetch(
        `/api/v2/super/tenants/${selectedTenant}/attendance-report/${editRecord.id}`,
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

  const handlePrintPdf = () => {
    window.print();
  };

  const sortDirFor = (key: SortKey): SortDir => (sortKey === key ? sortDir : null);

  type Column = { key: SortKey; label: string; className?: string };
  const columns: Column[] = [
    { key: "userName", label: "受講者" },
    { key: "courseName", label: "コース" },
    { key: "lessonTitle", label: "レッスン" },
    { key: "date", label: "日付", className: "whitespace-nowrap" },
    { key: "entryAt", label: "入室", className: "whitespace-nowrap" },
    { key: "exitAt", label: "退室", className: "whitespace-nowrap" },
    { key: "exitReason", label: "退室理由" },
    { key: "quizScore", label: "テスト点数" },
    { key: "quizPassed", label: "合否" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">出席・テスト結果レポート</h1>

      {/* テナント選択 */}
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
        {report && (
          <Button variant="outline" onClick={handlePrintPdf}>PDF出力</Button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">{error}</div>
      )}

      {loading && <p className="text-muted-foreground">読み込み中...</p>}

      {report && !loading && (
        <div ref={tableRef}>
          {/* 印刷用ヘッダー */}
          <div className="print:block hidden mb-4">
            <h2 className="text-xl font-bold">{report.tenantName} — 出席・テスト結果レポート</h2>
            <p className="text-sm text-muted-foreground">
              出力日: {new Date().toLocaleDateString("ja-JP")}
            </p>
          </div>

          <p className="text-sm text-muted-foreground mb-2">
            {report.tenantName} — {filteredRecords.length}件
            {filteredRecords.length !== report.totalRecords && ` / 全${report.totalRecords}件`}
          </p>

          {/* フィルター行 */}
          <div className="flex flex-wrap gap-2 mb-3 print:hidden">
            <Input
              placeholder="受講者名で絞り込み"
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              className="w-44 h-8 text-xs"
            />
            <Select value={filterCourse || "__all__"} onValueChange={(v) => setFilterCourse(v === "__all__" ? "" : v)}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue placeholder="コース" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全コース</SelectItem>
                {courseOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="レッスン名で絞り込み"
              value={filterLesson}
              onChange={(e) => setFilterLesson(e.target.value)}
              className="w-44 h-8 text-xs"
            />
            <Select value={filterExitReason || "__all__"} onValueChange={(v) => setFilterExitReason(v === "__all__" ? "" : v)}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue placeholder="退室理由" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全退室理由</SelectItem>
                {Object.entries(EXIT_REASON_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterQuizPassed || "__all__"} onValueChange={(v) => setFilterQuizPassed(v === "__all__" ? "" : v)}>
              <SelectTrigger className="w-32 h-8 text-xs">
                <SelectValue placeholder="合否" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全て</SelectItem>
                <SelectItem value="passed">合格</SelectItem>
                <SelectItem value="failed">不合格</SelectItem>
                <SelectItem value="none">未受験</SelectItem>
              </SelectContent>
            </Select>
            {(filterUser || filterCourse || filterLesson || filterExitReason || filterQuizPassed) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setFilterUser("");
                  setFilterCourse("");
                  setFilterLesson("");
                  setFilterExitReason("");
                  setFilterQuizPassed("");
                }}
              >
                フィルタ解除
              </Button>
            )}
          </div>

          {filteredRecords.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-muted-foreground">
              データがありません
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((col) => (
                      <TableHead
                        key={col.key}
                        className={`cursor-pointer select-none hover:bg-muted/50 ${col.className ?? ""}`}
                        onClick={() => toggleSort(col.key)}
                      >
                        {col.label}
                        <SortIcon dir={sortDirFor(col.key)} />
                      </TableHead>
                    ))}
                    <TableHead className="print:hidden">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRecords.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="text-sm">{r.userName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{r.userEmail}</div>
                      </TableCell>
                      <TableCell className="text-sm">{r.courseName}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm">{r.lessonTitle}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatDate(r.entryAt)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatTime(r.entryAt)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatTime(r.exitAt)}</TableCell>
                      <TableCell className="text-sm">
                        {r.exitReason ? (EXIT_REASON_LABELS[r.exitReason] ?? r.exitReason) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.quizScore !== null ? `${r.quizScore}点` : "—"}
                      </TableCell>
                      <TableCell>
                        {r.quizPassed === null
                          ? "—"
                          : r.quizPassed
                            ? <span className="text-green-600 font-medium">合格</span>
                            : <span className="text-destructive font-medium">不合格</span>}
                      </TableCell>
                      <TableCell className="print:hidden">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                          編集
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
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
            <DialogTitle>レコードを編集</DialogTitle>
            <DialogDescription>
              {editRecord?.userName ?? editRecord?.userEmail} — {editRecord?.lessonTitle}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">入室時刻</label>
              <Input
                type="datetime-local"
                value={editEntryAt}
                onChange={(e) => setEditEntryAt(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">退室時刻</label>
              <Input
                type="datetime-local"
                value={editExitAt}
                onChange={(e) => setEditExitAt(e.target.value)}
              />
            </div>
            {editRecord?.quizAttemptId && (
              <>
                <div className="space-y-1">
                  <label className="text-sm font-medium">テスト点数</label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={editScore}
                    onChange={(e) => setEditScore(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">合否</label>
                  <Select value={editPassed} onValueChange={setEditPassed}>
                    <SelectTrigger>
                      <SelectValue placeholder="選択" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">合格</SelectItem>
                      <SelectItem value="false">不合格</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            {editError && (
              <div className="text-sm text-destructive">{editError}</div>
            )}
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
