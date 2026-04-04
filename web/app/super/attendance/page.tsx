"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import type { FilterOption } from "@/components/multi-select-filter";
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

/** ISO文字列からJST日付部分(yyyy-MM-dd)を取得 */
function isoToDateJST(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("sv", { timeZone: "Asia/Tokyo" });
}

/** ISO文字列からJST時刻部分(HH:mm)を取得 */
function isoToTimeJST(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("sv", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 日付(yyyy-MM-dd) + 時刻(HH:mm) をJSTとしてISO UTC文字列に変換 */
function dateTimeJSTtoISO(date: string, time: string): string {
  // JSTオフセット (+09:00) を付与して正しいUTCに変換
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

const EXIT_REASON_LABELS: Record<string, string> = {
  quiz_submitted: "テスト合格",
  pause_timeout: "一時停止超過",
  time_limit: "時間制限",
  browser_close: "ブラウザ終了",
  max_attempts_failed: "受験上限(不合格)",
};

type Column = { key: SortKey; label: string; className?: string };
const COLUMNS: Column[] = [
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

  // フィルター（複数選択）
  const [filterUsers, setFilterUsers] = useState<Set<string>>(new Set());
  const [filterCourses, setFilterCourses] = useState<Set<string>>(new Set());
  const [filterLessons, setFilterLessons] = useState<Set<string>>(new Set());
  const [filterExitReasons, setFilterExitReasons] = useState<Set<string>>(new Set());
  const [filterQuizPassed, setFilterQuizPassed] = useState<Set<string>>(new Set());

  // ソート
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  // 編集ダイアログ
  const [editOpen, setEditOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<SuperAttendanceRecord | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editEntryTime, setEditEntryTime] = useState("");
  const [editExitTime, setEditExitTime] = useState("");
  const [editScore, setEditScore] = useState("");
  const [editPassed, setEditPassed] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // PDF出力ダイアログ
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);
  const [pdfColumns, setPdfColumns] = useState<Set<string>>(new Set());

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
      setFilterUsers(new Set());
      setFilterCourses(new Set());
      setFilterLessons(new Set());
      setFilterExitReasons(new Set());
      setFilterQuizPassed(new Set());
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

  // フィルタ用オプション（ラベル名で表示、重複排除）
  const userOptions: FilterOption[] = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, string>();
    for (const r of report.records) {
      if (r.userId && !map.has(r.userId)) {
        map.set(r.userId, r.userName ?? r.userEmail ?? r.userId);
      }
    }
    return Array.from(map, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ja"));
  }, [report]);

  const courseOptions: FilterOption[] = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, string>();
    for (const r of report.records) {
      if (r.courseId && !map.has(r.courseId)) {
        map.set(r.courseId, r.courseName || r.courseId);
      }
    }
    return Array.from(map, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ja"));
  }, [report]);

  const lessonOptions: FilterOption[] = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, string>();
    for (const r of report.records) {
      if (r.lessonId && !map.has(r.lessonId)) {
        map.set(r.lessonId, r.lessonTitle || r.lessonId);
      }
    }
    return Array.from(map, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ja"));
  }, [report]);

  const exitReasonOptions: FilterOption[] = Object.entries(EXIT_REASON_LABELS).map(([value, label]) => ({ value, label }));
  const quizPassedOptions: FilterOption[] = [
    { value: "passed", label: "合格" },
    { value: "failed", label: "不合格" },
    { value: "none", label: "未受験" },
  ];

  // フィルタ＋ソート適用
  const filteredRecords = useMemo(() => {
    if (!report) return [];
    let records = report.records;

    // フィルタ（複数選択対応）
    if (filterUsers.size > 0) {
      records = records.filter((r) => filterUsers.has(r.userId));
    }
    if (filterCourses.size > 0) {
      records = records.filter((r) => filterCourses.has(r.courseId));
    }
    if (filterLessons.size > 0) {
      records = records.filter((r) => filterLessons.has(r.lessonId));
    }
    if (filterExitReasons.size > 0) {
      records = records.filter((r) => r.exitReason !== null && filterExitReasons.has(r.exitReason));
    }
    if (filterQuizPassed.size > 0) {
      records = records.filter((r) => {
        if (filterQuizPassed.has("passed") && r.quizPassed === true) return true;
        if (filterQuizPassed.has("failed") && r.quizPassed === false) return true;
        if (filterQuizPassed.has("none") && r.quizPassed === null) return true;
        return false;
      });
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
  }, [report, filterUsers, filterCourses, filterLessons, filterExitReasons, filterQuizPassed, sortKey, sortDir]);

  const openEdit = (record: SuperAttendanceRecord) => {
    setEditRecord(record);
    setEditDate(isoToDateJST(record.entryAt));
    setEditEntryTime(isoToTimeJST(record.entryAt));
    setEditExitTime(isoToTimeJST(record.exitAt));
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
      if (editDate && editEntryTime) {
        body.entryAt = dateTimeJSTtoISO(editDate, editEntryTime);
      }
      if (editDate && editExitTime) {
        body.exitAt = dateTimeJSTtoISO(editDate, editExitTime);
      }
      if (editScore !== "") {
        body.quizScore = Number(editScore);
      }
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
      const scrollY = window.scrollY;
      await fetchReport();
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditLoading(false);
    }
  };

  const openPdfDialog = () => {
    setPdfColumns(new Set(COLUMNS.map((c) => c.key)));
    setPdfDialogOpen(true);
  };

  const handlePrintPdf = () => {
    if (!tableRef.current) return;
    // 非選択カラムを一時非表示
    const hidden: HTMLElement[] = [];
    for (const col of COLUMNS) {
      if (!pdfColumns.has(col.key)) {
        const els = tableRef.current.querySelectorAll<HTMLElement>(`[data-col="${col.key}"]`);
        els.forEach((el) => {
          el.style.display = "none";
          hidden.push(el);
        });
      }
    }
    setPdfDialogOpen(false);
    // 次のフレームで印刷（ダイアログが閉じてから）
    requestAnimationFrame(() => {
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        hidden.forEach((el) => { el.style.display = ""; });
        window.removeEventListener("afterprint", restore);
      };
      window.addEventListener("afterprint", restore);
      setTimeout(restore, 5000); // afterprint未発火時のフォールバック
      window.print();
    });
  };

  const sortDirFor = (key: SortKey): SortDir => (sortKey === key ? sortDir : null);

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
          <Button variant="outline" onClick={openPdfDialog}>PDF出力</Button>
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
            <MultiSelectFilter
              label="受講者"
              options={userOptions}
              selected={filterUsers}
              onChange={setFilterUsers}
              searchable
            />
            <MultiSelectFilter
              label="コース"
              options={courseOptions}
              selected={filterCourses}
              onChange={setFilterCourses}
            />
            <MultiSelectFilter
              label="レッスン"
              options={lessonOptions}
              selected={filterLessons}
              onChange={setFilterLessons}
              searchable
            />
            <MultiSelectFilter
              label="退室理由"
              options={exitReasonOptions}
              selected={filterExitReasons}
              onChange={setFilterExitReasons}
            />
            <MultiSelectFilter
              label="合否"
              options={quizPassedOptions}
              selected={filterQuizPassed}
              onChange={setFilterQuizPassed}
            />
            {(filterUsers.size > 0 || filterCourses.size > 0 || filterLessons.size > 0 || filterExitReasons.size > 0 || filterQuizPassed.size > 0) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setFilterUsers(new Set());
                  setFilterCourses(new Set());
                  setFilterLessons(new Set());
                  setFilterExitReasons(new Set());
                  setFilterQuizPassed(new Set());
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
                    {COLUMNS.map((col) => (
                      <TableHead
                        key={col.key}
                        data-col={col.key}
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
                      <TableCell data-col="userName">
                        <div className="text-sm">{r.userName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{r.userEmail}</div>
                      </TableCell>
                      <TableCell data-col="courseName" className="text-sm">{r.courseName}</TableCell>
                      <TableCell data-col="lessonTitle" className="max-w-[200px] truncate text-sm">{r.lessonTitle}</TableCell>
                      <TableCell data-col="date" className="whitespace-nowrap text-sm">{formatDate(r.entryAt)}</TableCell>
                      <TableCell data-col="entryAt" className="whitespace-nowrap text-sm">{formatTime(r.entryAt)}</TableCell>
                      <TableCell data-col="exitAt" className="whitespace-nowrap text-sm">{formatTime(r.exitAt)}</TableCell>
                      <TableCell data-col="exitReason" className="text-sm">
                        {r.exitReason ? (EXIT_REASON_LABELS[r.exitReason] ?? r.exitReason) : "—"}
                      </TableCell>
                      <TableCell data-col="quizScore" className="text-sm">
                        {r.quizScore !== null ? `${r.quizScore}点` : "—"}
                      </TableCell>
                      <TableCell data-col="quizPassed">
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
      <Dialog open={editOpen} onOpenChange={(open) => { setEditOpen(open); if (!open) setEditRecord(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>レコードを編集</DialogTitle>
            <DialogDescription>
              {editRecord?.userName ?? editRecord?.userEmail} — {editRecord?.lessonTitle}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="edit-date" className="text-sm font-medium">日付</label>
              <Input
                id="edit-date"
                type="date"
                value={editDate}
                onChange={(e) => setEditDate(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label htmlFor="edit-entry" className="text-sm font-medium">入室時間</label>
                <Input
                  id="edit-entry"
                  type="time"
                  value={editEntryTime}
                  onChange={(e) => setEditEntryTime(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="edit-exit" className="text-sm font-medium">退室時間</label>
                <Input
                  id="edit-exit"
                  type="time"
                  value={editExitTime}
                  onChange={(e) => setEditExitTime(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-score" className="text-sm font-medium">テスト点数</label>
              <Input
                id="edit-score"
                type="number"
                min="0"
                max="100"
                step="1"
                value={editScore}
                onChange={(e) => setEditScore(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-passed" className="text-sm font-medium">合否</label>
              <Select value={editPassed} onValueChange={setEditPassed}>
                <SelectTrigger id="edit-passed">
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">合格</SelectItem>
                  <SelectItem value="false">不合格</SelectItem>
                </SelectContent>
              </Select>
            </div>
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

      {/* PDF出力カラム選択ダイアログ */}
      <Dialog open={pdfDialogOpen} onOpenChange={setPdfDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>PDF出力 — カラム選択</DialogTitle>
            <DialogDescription>
              出力するカラムを選択してください
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b">
              <Checkbox
                id="pdf-all"
                checked={pdfColumns.size === COLUMNS.length ? true : pdfColumns.size > 0 ? "indeterminate" : false}
                onCheckedChange={(checked) => {
                  setPdfColumns(checked ? new Set(COLUMNS.map((c) => c.key)) : new Set());
                }}
              />
              <label htmlFor="pdf-all" className="text-sm font-medium cursor-pointer">
                全選択
              </label>
            </div>
            {COLUMNS.map((col) => (
              <div key={col.key} className="flex items-center gap-2">
                <Checkbox
                  id={`pdf-${col.key}`}
                  checked={pdfColumns.has(col.key)}
                  onCheckedChange={(checked) => {
                    const next = new Set(pdfColumns);
                    if (checked) next.add(col.key);
                    else next.delete(col.key);
                    setPdfColumns(next);
                  }}
                />
                <label htmlFor={`pdf-${col.key}`} className="text-sm cursor-pointer">
                  {col.label}
                </label>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPdfDialogOpen(false)}>キャンセル</Button>
            <Button onClick={handlePrintPdf} disabled={pdfColumns.size === 0}>
              出力
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
