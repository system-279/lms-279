"use client";

/**
 * ドライラン: 次回 cron で送信される対象を取得して表示する。
 * POST /api/v2/super/dispatch/dry-run (Gmail 送信も Reservation も行わない、AC-8)。
 */

import { useState } from "react";
import type { DryRunResponse } from "@lms-279/shared-types";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSuperAdminFetch } from "@/lib/super-api";
import { getDispatchErrorMessage } from "../errorMessage";

export function DryRunPanel() {
  const { superFetch } = useSuperAdminFetch();
  const [result, setResult] = useState<DryRunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runDryRun = async () => {
    setLoading(true);
    setError(null);
    setResult(null); // 再実行時に前回結果を消し、失敗時に古い対象が残らないようにする
    try {
      const data = await superFetch<DryRunResponse>(
        "/api/v2/super/dispatch/dry-run",
        { method: "POST" },
      );
      setResult(data);
    } catch (e) {
      setError(getDispatchErrorMessage(e, "ドライランに失敗しました"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={runDryRun} disabled={loading}>
          {loading ? "実行中..." : "ドライラン実行"}
        </Button>
        <p className="text-xs text-muted-foreground">
          次回配信される対象を確認します (送信はしません)。
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <p className="text-sm">
            送信対象: <span className="font-medium">{result.wouldNotify.length}</span> 件
            <span className="text-muted-foreground">
              {" "}
              (評価時刻 {new Date(result.evaluatedAt).toLocaleString("ja-JP")})
            </span>
          </p>
          {result.wouldNotify.length === 0 ? (
            <div className="rounded-md border p-4 text-center text-muted-foreground text-sm">
              送信対象はありません
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>テナント</TableHead>
                  <TableHead>受講者</TableHead>
                  <TableHead>メール</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.wouldNotify.map((t) => (
                  <TableRow key={`${t.tenantId}:${t.userId}`}>
                    <TableCell>{t.tenantId}</TableCell>
                    <TableCell>{t.userName}</TableCell>
                    <TableCell>{t.userEmail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}
