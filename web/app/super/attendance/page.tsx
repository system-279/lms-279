"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

type Tenant = {
  id: string;
  name: string;
};

type AttendanceRecord = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  lessonId: string;
  lessonTitle: string;
  date: string | null;
  entryAt: string | null;
  exitAt: string | null;
  exitReason: string | null;
  status: string;
  quizAttemptId: string | null;
  quizScore: number | null;
  quizPassed: boolean | null;
  quizSubmittedAt: string | null;
};

type ReportResponse = {
  tenantId: string;
  tenantName: string;
  records: AttendanceRecord[];
  totalRecords: number;
};

/** ISO UTC文字列をdatetime-local用のローカル時刻文字列に変換 */
function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

/** datetime-local値をISO UTC文字列に変換 */
function datetimeLocalToISO(local: string): string {
  return new Date(local).toISOString();
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EXIT_REASON_LABELS: Record<string, string> = {
  quiz_submitted: "テスト合格",
  pause_timeout: "一時停止超過",
  time_limit: "時間制限",
  browser_close: "ブラウザ終了",
  max_attempts_failed: "受験上限(不合格)",
};

export default function AttendanceReportPage() {
  const { superFetch } = useSuperAdminFetch();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<AttendanceRecord | null>(null);
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

  const fetchReport = useCallback(async () => {
    if (!selectedTenant) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      const qs = params.toString();
      const data = await superFetch<ReportResponse>(
        `/api/v2/super/tenants/${selectedTenant}/attendance-report${qs ? `?${qs}` : ""}`
      );
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [superFetch, selectedTenant, dateFrom, dateTo]);

  const openEdit = (record: AttendanceRecord) => {
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">出席・テスト結果レポート</h1>

      {/* フィルター */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label className="text-sm font-medium">テナント</label>
          <Select value={selectedTenant} onValueChange={setSelectedTenant}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="テナントを選択" />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">開始日</label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">終了日</label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-40"
          />
        </div>
        <Button onClick={fetchReport} disabled={!selectedTenant || loading}>
          {loading ? "取得中..." : "表示"}
        </Button>
        {report && (
          <Button variant="outline" onClick={handlePrintPdf}>
            PDF出力
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
        <div ref={tableRef}>
          <div className="print:block hidden mb-4">
            <h2 className="text-xl font-bold">{report.tenantName} — 出席・テスト結果レポート</h2>
            <p className="text-sm text-muted-foreground">
              {dateFrom && dateTo
                ? `期間: ${dateFrom} 〜 ${dateTo}`
                : dateFrom
                  ? `${dateFrom} 以降`
                  : dateTo
                    ? `${dateTo} まで`
                    : "全期間"}
              {" / "}出力日: {new Date().toLocaleDateString("ja-JP")}
            </p>
          </div>

          <p className="text-sm text-muted-foreground mb-2">
            {report.tenantName} — {report.totalRecords}件
          </p>

          {report.records.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-muted-foreground">
              データがありません
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>日付</TableHead>
                    <TableHead>受講者</TableHead>
                    <TableHead>レッスン</TableHead>
                    <TableHead>入室</TableHead>
                    <TableHead>退室</TableHead>
                    <TableHead>退室理由</TableHead>
                    <TableHead>テスト点数</TableHead>
                    <TableHead>合否</TableHead>
                    <TableHead className="print:hidden">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.records.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{r.date ?? "—"}</TableCell>
                      <TableCell>
                        <div className="text-sm">{r.userName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{r.userEmail}</div>
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate">{r.lessonTitle}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatTime(r.entryAt)}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatTime(r.exitAt)}</TableCell>
                      <TableCell>{r.exitReason ? (EXIT_REASON_LABELS[r.exitReason] ?? r.exitReason) : "—"}</TableCell>
                      <TableCell>{r.quizScore !== null ? `${r.quizScore}点` : "—"}</TableCell>
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
