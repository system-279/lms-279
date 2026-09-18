"use client";

/**
 * スーパー管理者: 送信実績一覧ページ (PR2a、配信可視化)。
 *
 * GET /api/v2/super/dispatch/send-history?lane=&tenantId=&limit=&cursor= を呼び、
 * cursor paginate で累積 append する (AuditLogTable.tsx と同型のパターン)。
 *
 * 「いつ・どのテナントの・誰に送ったか」を受講者単位で確認するための画面。
 * `/super/dispatch-settings` の実行履歴・監査ログは run 単位の集計/操作ログのため、
 * 個々の受講者への送信有無を追いたい場合は本画面を使う。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DispatchLane,
  GetSendHistoryResponse,
  SendHistoryEntry,
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
import { getDispatchErrorMessage } from "../dispatch-settings/errorMessage";

/** Radix Select は value="" を許容しないので「すべて」用の sentinel を用意 */
const ALL_LANES = "__all__" as const;
type FilterLane = typeof ALL_LANES | DispatchLane;

const LANE_OPTIONS: { value: FilterLane; label: string }[] = [
  { value: ALL_LANES, label: "すべて" },
  { value: "completion", label: "完了通知" },
  { value: "progress", label: "進捗レポート" },
];

const LANE_LABEL: Record<DispatchLane, string> = {
  completion: "完了通知",
  progress: "進捗レポート",
};

/** completion/progress 両レーンの status 値をまとめて日本語化 */
const STATUS_LABEL: Record<string, string> = {
  reserved: "予約済み",
  sent: "送信済み",
  failed_permanent: "失敗（恒久）",
  manual_review_required: "要手動確認",
  pending: "処理中",
  failed: "失敗",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function statusVariant(status: string): "default" | "destructive" | "outline" {
  if (status === "sent") return "default";
  if (status === "failed" || status === "failed_permanent") return "destructive";
  return "outline";
}

interface FilterState {
  lane: FilterLane;
  tenantId: string;
}

const EMPTY_FILTER: FilterState = { lane: ALL_LANES, tenantId: "" };

function buildQuery(filter: FilterState, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filter.lane !== ALL_LANES) params.set("lane", filter.lane);
  if (filter.tenantId.trim()) params.set("tenantId", filter.tenantId.trim());
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ja-JP");
}

export default function DispatchHistoryPage() {
  const { superFetch } = useSuperAdminFetch();
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [activeFilter, setActiveFilter] = useState<FilterState>(EMPTY_FILTER);
  const [items, setItems] = useState<SendHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchHistory = useCallback(
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
        const data = await superFetch<GetSendHistoryResponse>(
          `/api/v2/super/dispatch/send-history${q}`,
        );
        if (requestIdRef.current !== myRequestId) return;
        setItems((prev) =>
          mode === "append" ? [...prev, ...data.items] : data.items,
        );
        setNextCursor(data.nextCursor);
      } catch (e) {
        if (requestIdRef.current !== myRequestId) return;
        setError(getDispatchErrorMessage(e, "送信実績の取得に失敗しました"));
      } finally {
        if (requestIdRef.current === myRequestId) {
          setLoading(false);
        }
      }
    },
    [superFetch],
  );

  useEffect(() => {
    fetchHistory(EMPTY_FILTER, null, "replace");
  }, [fetchHistory]);

  const handleApply = () => {
    setActiveFilter(filter);
    setItems([]);
    setNextCursor(null);
    fetchHistory(filter, null, "replace");
  };

  const handleLoadMore = () => {
    if (!nextCursor || loading) return;
    fetchHistory(activeFilter, nextCursor, "append");
  };

  const handleRetry = () => {
    fetchHistory(activeFilter, null, "replace");
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-bold">送信実績</h1>
        <p className="text-sm text-muted-foreground">
          自動配信で「いつ・どのテナントの・誰に送ったか」を受講者単位で確認できます。
        </p>
      </div>

      <div className="space-y-1 rounded-md border border-l-4 border-l-amber-500 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
        <p>
          氏名・メールアドレスは現在の登録情報に基づいて表示されます。改名・メールアドレス変更・退会後は、実際に送信した当時の宛先と異なる場合があります。
        </p>
        <p>
          進捗レポートの送信実績は直近 90
          日分のみ保持されます（完了通知はテナントに存在する限り保持）。
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs">レーン</label>
          <Select
            value={filter.lane}
            onValueChange={(v) => setFilter({ ...filter, lane: v as FilterLane })}
          >
            <SelectTrigger className="w-40" aria-label="レーン">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
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
        <Button variant="outline" onClick={handleApply}>
          絞り込む
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

      {!error && items.length === 0 && !loading ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground text-center">
          該当する送信実績はありません
        </div>
      ) : !error ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>処理日時</TableHead>
              <TableHead>送信完了時刻</TableHead>
              <TableHead>レーン</TableHead>
              <TableHead>テナント</TableHead>
              <TableHead>受講者</TableHead>
              <TableHead>ステータス</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={`${item.lane}:${item.tenantId}:${item.docId}`}>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatDateTime(item.processedAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatDateTime(item.sentAt)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{LANE_LABEL[item.lane]}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  <span>{item.tenantName}</span>{" "}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    ({item.tenantId})
                  </span>
                </TableCell>
                <TableCell className="text-xs">
                  {item.userName ?? "(不明)"}{" "}
                  {item.userEmail && (
                    <span className="text-muted-foreground">
                      &lt;{item.userEmail}&gt;
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(item.status)}>
                    {statusLabel(item.status)}
                  </Badge>
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
            もっと読み込む
          </Button>
        )}
      </div>
    </div>
  );
}
