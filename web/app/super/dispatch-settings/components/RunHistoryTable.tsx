"use client";

/**
 * 配信 Run 履歴表示 (Phase 6 PR-F2)。
 *
 * GET /api/v2/super/dispatch/runs?limit=&cursor= を呼び、cursor paginate で累積 append。
 *
 * State race 対策: AuditLogTable と同じく `requestIdRef` で fetch ごとに採番し、
 * 古いレスポンスは破棄する (連打 / 連続再読み込み時の古い結果 append を防ぐ)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DispatchRun,
  DispatchRunStatus,
  GetRunsResponse,
} from "@lms-279/shared-types";
import { useSuperAdminFetch } from "@/lib/super-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDispatchErrorMessage } from "../errorMessage";

function statusBadgeVariant(
  status: DispatchRunStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "secondary"; // 緑系を tailwind class で別途付ける
    case "running":
    case "aborted":
    case "timeout":
      return "destructive";
    default:
      return "outline";
  }
}

function statusBadgeClass(status: DispatchRunStatus): string {
  if (status === "completed") {
    return "bg-emerald-100 text-emerald-800 border-emerald-200";
  }
  return "";
}

/** ステータス値 → 日本語 label（未知の値は値そのまま表示） */
function statusLabel(status: DispatchRunStatus): string {
  switch (status) {
    case "running":
      return "実行中";
    case "completed":
      return "正常終了";
    case "timeout":
      return "タイムアウト";
    case "aborted":
      return "中断";
    default:
      return status;
  }
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

function truncate(text: string | null, max = 60): string {
  if (!text) return "-";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function RunHistoryTable() {
  const { superFetch } = useSuperAdminFetch();
  const [runs, setRuns] = useState<DispatchRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchRuns = useCallback(
    async (cursor: string | null, mode: "replace" | "append") => {
      const myRequestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const data = await superFetch<GetRunsResponse>(
          `/api/v2/super/dispatch/runs${q}`,
        );
        // state race: 最新でない fetch のレスポンスは破棄
        if (requestIdRef.current !== myRequestId) return;
        setRuns((prev) =>
          mode === "append" ? [...prev, ...data.runs] : data.runs,
        );
        setNextCursor(data.nextCursor);
      } catch (e) {
        if (requestIdRef.current !== myRequestId) return;
        setError(getDispatchErrorMessage(e, "配信実行履歴の取得に失敗しました"));
      } finally {
        if (requestIdRef.current === myRequestId) {
          setLoading(false);
        }
      }
    },
    [superFetch],
  );

  useEffect(() => {
    fetchRuns(null, "replace");
  }, [fetchRuns]);

  const handleLoadMore = () => {
    if (!nextCursor || loading) return;
    fetchRuns(nextCursor, "append");
  };

  const handleRetry = () => {
    fetchRuns(null, "replace");
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="space-y-2">
          <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
            {error}
          </div>
          <Button variant="outline" onClick={handleRetry}>
            再読み込み
          </Button>
        </div>
      )}

      {!error && runs.length === 0 && !loading ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground text-center">
          配信実行の履歴はまだありません
        </div>
      ) : !error ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>実行 ID</TableHead>
              <TableHead>実行日時</TableHead>
              <TableHead>状態</TableHead>
              <TableHead className="text-right">対象テナント数</TableHead>
              <TableHead className="text-right">送信数</TableHead>
              <TableHead className="text-right">スキップ数</TableHead>
              <TableHead className="text-right">失敗数</TableHead>
              <TableHead className="text-right">要確認</TableHead>
              <TableHead>中断・エラーの理由</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.runId}>
                <TableCell className="font-mono text-xs">{run.runId}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatDateTime(run.triggeredAt)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={statusBadgeVariant(run.status)}
                    className={statusBadgeClass(run.status)}
                  >
                    {statusLabel(run.status)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-xs">
                  {run.processedTenants}
                </TableCell>
                <TableCell className="text-right text-xs">{run.sent}</TableCell>
                <TableCell className="text-right text-xs">
                  {run.skipped}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {run.failed}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {run.manualReviewRequired}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {truncate(run.abortedReason)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <div className="flex items-center gap-2">
        {loading && (
          <span className="text-xs text-muted-foreground">読み込み中...</span>
        )}
        {nextCursor && !loading && !error && (
          <Button variant="outline" onClick={handleLoadMore}>
            続きを読み込む
          </Button>
        )}
      </div>
    </div>
  );
}
