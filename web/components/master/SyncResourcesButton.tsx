"use client";

import { useState } from "react";
import type { SyncResourcesResponse } from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { useSuperAdminFetch } from "@/lib/super-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SyncResourcesButtonProps {
  courseId: string;
}

function formatSyncResult(result: SyncResourcesResponse): string {
  const { tenantsCount, lessonsCount, removedCount } = result;
  // 配信先 0 件 OR 更新対象 0 件は同一文言で扱う (Evaluator HIGH 指摘: parts 空時の文法バグ防止)
  if (lessonsCount === 0 && removedCount === 0) {
    return tenantsCount === 0
      ? "このコースを配信しているテナントがありません。"
      : `配信先の ${tenantsCount} テナントには、更新対象の資料がありませんでした。`;
  }
  const parts: string[] = [];
  if (lessonsCount > 0) parts.push(`${lessonsCount} 件のレッスン資料を反映`);
  if (removedCount > 0) parts.push(`${removedCount} 件のレッスン資料を削除`);
  return `${tenantsCount} 件のテナントに対し、${parts.join("、")}しました。`;
}

function formatSyncError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "not_found") return "マスターコースが見つかりません。";
    return err.message || "反映に失敗しました。";
  }
  if (err instanceof Error) return err.message;
  return "反映に失敗しました。";
}

export function SyncResourcesButton({
  courseId,
}: SyncResourcesButtonProps): React.ReactElement {
  const { superFetch } = useSuperAdminFetch();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await superFetch<SyncResourcesResponse>(
        `/api/v2/super/master/courses/${courseId}/sync-resources`,
        { method: "POST" },
      );
      setResult(res);
      setConfirmOpen(false);
    } catch (e) {
      setError(formatSyncError(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setResult(null);
          setConfirmOpen(true);
        }}
      >
        配信済みテナントに資料情報を反映
      </Button>

      {result && (
        <p
          className="text-xs text-emerald-600"
          role="status"
          aria-live="polite"
        >
          {formatSyncResult(result)}
        </p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>資料情報を、配信済みテナントに反映しますか?</DialogTitle>
            <DialogDescription>
              このコースを既に配信しているテナントすべてに、各レッスンの資料
              PDF の情報 (ファイル名・サイズ・更新日時) を最新に揃えます。
              マスター側で削除した PDF は、テナント側でも見えなくなります。
              クラウドに保存されている PDF ファイル本体はそのままで、移動も
              削除もされません。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={running}
            >
              キャンセル
            </Button>
            <Button type="button" onClick={handleRun} disabled={running}>
              {running ? "実行中..." : "実行する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
