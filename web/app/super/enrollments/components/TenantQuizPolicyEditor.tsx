"use client";

/**
 * テナント別 テスト任意化設定エディタ (Stage 2)。
 *
 * - GET /api/v2/super/tenants/:id/quiz-policy で現在の設定を取得
 * - Switch 2 つ（テスト任意化マスター ON/OFF、スキップ者への資料PDFダウンロード許可）
 * - サブ設定は master OFF 時 disabled（誤解防止。値そのものは保持し、正規化しない）
 * - PUT で保存（差分があるときのみ有効、always-send-all）
 *
 * TenantCcEditor.tsx（web/app/super/dispatch-settings/components/）の
 * original 値 / isDirty / always-send-all 構造を踏襲。
 */

import { useCallback, useEffect, useState } from "react";
import type { TenantQuizPolicyResponse, PutTenantQuizPolicyRequest } from "@lms-279/shared-types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSuperAdminFetch } from "@/lib/super-api";

export function TenantQuizPolicyEditor({ tenantId }: { tenantId: string }) {
  const { superFetch } = useSuperAdminFetch();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [originalQuizSkipEnabled, setOriginalQuizSkipEnabled] = useState(false);
  const [originalPdfDownloadAllowedForSkipped, setOriginalPdfDownloadAllowedForSkipped] =
    useState(false);
  const [quizSkipEnabled, setQuizSkipEnabled] = useState(false);
  const [pdfDownloadAllowedForSkipped, setPdfDownloadAllowedForSkipped] = useState(false);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyLoaded = (data: TenantQuizPolicyResponse) => {
    setOriginalQuizSkipEnabled(data.quizSkipEnabled);
    setOriginalPdfDownloadAllowedForSkipped(data.pdfDownloadAllowedForSkipped);
    setQuizSkipEnabled(data.quizSkipEnabled);
    setPdfDownloadAllowedForSkipped(data.pdfDownloadAllowedForSkipped);
    setUpdatedBy(data.updatedBy);
  };

  const loadPolicy = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaveError(null);
    setNotice(null);
    try {
      const data = await superFetch<TenantQuizPolicyResponse>(
        `/api/v2/super/tenants/${tenantId}/quiz-policy`
      );
      applyLoaded(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "テスト任意化設定の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [tenantId, superFetch]);

  useEffect(() => {
    loadPolicy();
  }, [loadPolicy]);

  const isDirty =
    quizSkipEnabled !== originalQuizSkipEnabled ||
    pdfDownloadAllowedForSkipped !== originalPdfDownloadAllowedForSkipped;

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    const body: PutTenantQuizPolicyRequest = {
      quizSkipEnabled,
      pdfDownloadAllowedForSkipped,
    };
    try {
      const updated = await superFetch<TenantQuizPolicyResponse>(
        `/api/v2/super/tenants/${tenantId}/quiz-policy`,
        { method: "PUT", body: JSON.stringify(body) }
      );
      applyLoaded(updated);
      setNotice("保存しました。");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">テスト任意化設定を読み込み中...</div>;
  }
  if (error) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">{error}</div>
        <Button variant="outline" onClick={loadPolicy}>
          再読み込み
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border p-6 space-y-3 max-w-lg">
      <h3 className="text-lg font-semibold">テスト任意化設定</h3>
      <p className="text-sm text-muted-foreground">
        ONにすると、このテナントの受講者は動画視聴後にテストを受けずにレッスンを完了扱いにできます（動画視聴は引き続き必須）。
      </p>

      <label className="flex items-center gap-3 text-sm">
        <Switch
          checked={quizSkipEnabled}
          onCheckedChange={setQuizSkipEnabled}
          disabled={saving}
          aria-label="このテナントのテスト任意化を有効化"
        />
        <span>{quizSkipEnabled ? "テスト任意化 ON" : "テスト任意化 OFF"}</span>
      </label>

      <label className="flex items-center gap-3 text-sm">
        <Switch
          checked={pdfDownloadAllowedForSkipped}
          onCheckedChange={setPdfDownloadAllowedForSkipped}
          disabled={saving || !quizSkipEnabled}
          aria-label="スキップした受講者への資料PDFダウンロードを許可"
        />
        <span>
          {pdfDownloadAllowedForSkipped
            ? "スキップした受講者への資料PDFダウンロード 許可 ON"
            : "スキップした受講者への資料PDFダウンロード 許可 OFF"}
        </span>
      </label>
      {!quizSkipEnabled && (
        <p className="text-xs text-muted-foreground">
          テスト任意化がOFFのため、このスイッチは操作できません（値は保持されます）。
        </p>
      )}

      {updatedBy && (
        <p className="text-xs text-muted-foreground">
          設定者: <span className="font-mono">{updatedBy}</span>
        </p>
      )}

      {saveError && (
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">{saveError}</div>
      )}
      {notice && (
        <div className="rounded-md bg-primary/10 p-3 text-sm">{notice}</div>
      )}

      <div>
        <Button onClick={handleSave} disabled={!isDirty || saving}>
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}
