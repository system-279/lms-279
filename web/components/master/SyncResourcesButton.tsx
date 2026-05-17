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
  if (tenantsCount === 0 && lessonsCount === 0 && removedCount === 0) {
    return "配信先テナントが見つからない、または PDF メタ更新対象のレッスンがありませんでした。";
  }
  const parts: string[] = [];
  if (lessonsCount > 0) parts.push(`PDF メタを ${lessonsCount} レッスンに反映`);
  if (removedCount > 0) parts.push(`${removedCount} レッスンの PDF メタを削除`);
  return `${tenantsCount} テナントに対し、${parts.join("、")}しました。`;
}

function formatSyncError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "not_found") return "マスターコースが見つかりません。";
    return err.message || "同期に失敗しました。";
  }
  if (err instanceof Error) return err.message;
  return "同期に失敗しました。";
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
        既存配信先に PDF メタを反映
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
            <DialogTitle>PDF メタを既存配信先に反映しますか?</DialogTitle>
            <DialogDescription>
              本コースの配信済みテナント全てに対し、マスターレッスンの PDF メタ
              (ファイル名 / サイズ / 更新日時) を遡及反映します。マスター側で
              PDF を削除済みのレッスンは、テナント側のメタもクリアします。
              GCS のファイル本体は移動しません。
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
