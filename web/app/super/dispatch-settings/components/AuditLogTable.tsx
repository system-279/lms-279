"use client";

/**
 * 配信 監査ログ表示 (Phase 6 PR-F2)。
 *
 * GET /api/v2/super/dispatch/audit-logs?eventType=&tenantId=&userId=&from=&to=&limit=&cursor=
 * を呼び、cursor paginate で累積 append。フィルタ変更時は結果配列リセット。
 *
 * State race 対策 (Codex 指摘):
 *   フィルタ変更直後に古い fetch のレスポンスが着信して結果配列を上書きする/append する
 *   race を防ぐため、`requestIdRef` で fetch ごとに採番。レスポンス着信時に最新と一致
 *   しない場合は破棄する (AbortController は React StrictMode の二重 effect で扱いづらい
 *   ため requestId 方式)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DispatchAuditEventType,
  DispatchAuditLog,
  GetAuditLogsResponse,
} from "@lms-279/shared-types";
import { useSuperAdminFetch } from "@/lib/super-api";
import { Badge } from "@/components/ui/badge";
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
import { getDispatchErrorMessage } from "../errorMessage";

/** Radix Select は value="" を許容しないので「すべて」用の sentinel を用意 */
const ALL_EVENT_TYPES = "__all__" as const;

type FilterEventType = typeof ALL_EVENT_TYPES | DispatchAuditEventType;

const EVENT_TYPE_OPTIONS: { value: FilterEventType; label: string }[] = [
  { value: ALL_EVENT_TYPES, label: "すべて" },
  { value: "run_started", label: "Run 開始" },
  { value: "run_completed", label: "Run 完了" },
  { value: "run_aborted", label: "Run 中断" },
  { value: "user_reserved", label: "ユーザー予約" },
  { value: "user_notified", label: "ユーザー通知済" },
  { value: "user_skipped", label: "ユーザー skip" },
  { value: "user_failed_transient", label: "一時失敗" },
  { value: "user_failed_permanent", label: "永続失敗" },
  { value: "manual_review_required", label: "手動確認要" },
  { value: "settings_updated", label: "設定更新" },
  { value: "test_send", label: "テスト送信" },
  { value: "dry_run", label: "ドライラン" },
  { value: "orphan_send", label: "孤児送信" },
];

interface FilterState {
  eventType: FilterEventType;
  tenantId: string;
  userId: string;
  /** datetime-local の生値 (`YYYY-MM-DDTHH:mm`)、API には ISO 文字列化して渡す */
  from: string;
  to: string;
}

const EMPTY_FILTER: FilterState = {
  eventType: ALL_EVENT_TYPES,
  tenantId: "",
  userId: "",
  from: "",
  to: "",
};

function buildQuery(filter: FilterState, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filter.eventType !== ALL_EVENT_TYPES) {
    params.set("eventType", filter.eventType);
  }
  if (filter.tenantId.trim()) params.set("tenantId", filter.tenantId.trim());
  if (filter.userId.trim()) params.set("userId", filter.userId.trim());
  if (filter.from.trim()) {
    params.set("from", new Date(filter.from).toISOString());
  }
  if (filter.to.trim()) {
    params.set("to", new Date(filter.to).toISOString());
  }
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

function truncate(text: string | null, max = 80): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function AuditLogTable() {
  const { superFetch } = useSuperAdminFetch();
  // 編集中フィルタ (Input/Select に bind) と適用済フィルタ (loadMore で使う) を分離する。
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [activeFilter, setActiveFilter] = useState<FilterState>(EMPTY_FILTER);
  const [logs, setLogs] = useState<DispatchAuditLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchLogs = useCallback(
    async (
      currentFilter: FilterState,
      cursor: string | null,
      mode: "replace" | "append",
    ) => {
      const myRequestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const q = buildQuery(currentFilter, cursor);
        const data = await superFetch<GetAuditLogsResponse>(
          `/api/v2/super/dispatch/audit-logs${q}`,
        );
        // state race: 最新 fetch でない場合は結果を捨てる (古い filter のレスポンスを破棄)
        if (requestIdRef.current !== myRequestId) return;
        setLogs((prev) =>
          mode === "append" ? [...prev, ...data.logs] : data.logs,
        );
        setNextCursor(data.nextCursor);
      } catch (e) {
        if (requestIdRef.current !== myRequestId) return;
        setError(getDispatchErrorMessage(e, "監査ログの取得に失敗しました"));
      } finally {
        if (requestIdRef.current === myRequestId) {
          setLoading(false);
        }
      }
    },
    [superFetch],
  );

  // 初回マウント時のみ「フィルタなし」で取得
  useEffect(() => {
    fetchLogs(EMPTY_FILTER, null, "replace");
  }, [fetchLogs]);

  const handleApply = () => {
    setActiveFilter(filter);
    setLogs([]); // フィルタ変更時に結果配列リセット
    setNextCursor(null);
    fetchLogs(filter, null, "replace");
  };

  const handleLoadMore = () => {
    if (!nextCursor || loading) return;
    fetchLogs(activeFilter, nextCursor, "append");
  };

  const handleRetry = () => {
    fetchLogs(activeFilter, null, "replace");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs">イベント</label>
          <Select
            value={filter.eventType}
            onValueChange={(v) =>
              setFilter({ ...filter, eventType: v as FilterEventType })
            }
          >
            <SelectTrigger className="w-44" aria-label="イベント種別">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPE_OPTIONS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs">テナント ID</label>
          <Input
            className="w-32"
            value={filter.tenantId}
            onChange={(e) => setFilter({ ...filter, tenantId: e.target.value })}
            placeholder="任意"
            aria-label="テナント ID"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs">ユーザー ID</label>
          <Input
            className="w-32"
            value={filter.userId}
            onChange={(e) => setFilter({ ...filter, userId: e.target.value })}
            placeholder="任意"
            aria-label="ユーザー ID"
          />
        </div>
        {/*
          datetime-local の値 ("YYYY-MM-DDTHH:mm") は `new Date()` でブラウザ local time
          として解釈されるため、label を「(JST)」と固定せず「(ローカル時刻)」とする。
          本プロダクトのユーザーは多くが JST 環境のためほぼ JST 入力になるが、海外出張中
          等で異なる timezone のブラウザを使う場合は local time として送信される。
          厳密な JST 強制が必要になった時点で +09:00 suffix の付与等を検討する。
        */}
        <div className="space-y-1">
          <label className="text-xs">From (ローカル時刻)</label>
          <Input
            type="datetime-local"
            className="w-44"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
            aria-label="From"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs">To (ローカル時刻)</label>
          <Input
            type="datetime-local"
            className="w-44"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
            aria-label="To"
          />
        </div>
        {/* disabled にしない: ユーザーが連打しても requestId 方式で古い fetch は破棄される */}
        <Button variant="outline" onClick={handleApply}>
          適用
        </Button>
      </div>

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

      {!error && logs.length === 0 && !loading ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground text-center">
          該当する監査ログはありません
        </div>
      ) : !error ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>発生時刻</TableHead>
              <TableHead>イベント</TableHead>
              <TableHead>テナント</TableHead>
              <TableHead>ユーザー</TableHead>
              <TableHead>エラー</TableHead>
              <TableHead className="text-right">処理時間</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.auditId}>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatDateTime(log.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">
                    {log.eventType}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{log.tenantId ?? "-"}</TableCell>
                <TableCell className="text-xs">{log.userId ?? "-"}</TableCell>
                <TableCell className="text-xs">
                  {log.errorCode ? (
                    <>
                      <span className="font-mono">{log.errorCode}</span>
                      {log.errorMessage && (
                        <span className="text-muted-foreground">
                          {" "}
                          {truncate(log.errorMessage)}
                        </span>
                      )}
                    </>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {log.durationMs != null ? `${log.durationMs}ms` : "-"}
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
            次の件を読み込む
          </Button>
        )}
      </div>
    </div>
  );
}
