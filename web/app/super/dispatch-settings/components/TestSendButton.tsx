"use client";

/**
 * テスト送信: スーパー管理者自身宛に固定ダミーメールを送る (AC-9)。
 * POST /api/v2/super/dispatch/test-send。To はサーバー側で自分の email に強制される。
 */

import { useState } from "react";
import type { TestSendResponse } from "@lms-279/shared-types";
import { Button } from "@/components/ui/button";
import { useSuperAdminFetch } from "@/lib/super-api";
import { getDispatchErrorMessage } from "../errorMessage";

export function TestSendButton() {
  const { superFetch } = useSuperAdminFetch();
  const [result, setResult] = useState<TestSendResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testSend = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await superFetch<TestSendResponse>(
        "/api/v2/super/dispatch/test-send",
        { method: "POST" },
      );
      setResult(data);
    } catch (e) {
      setError(getDispatchErrorMessage(e, "テスト送信に失敗しました"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={testSend} disabled={loading}>
          {loading ? "送信中..." : "テスト送信"}
        </Button>
        <p className="text-xs text-muted-foreground">
          固定のダミー本文をログイン中の管理者自身宛に送信します。
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          {result.sentTo} に送信しました (messageId: {result.messageId})。
        </div>
      )}
    </div>
  );
}
