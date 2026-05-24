"use client";

/**
 * テナント別 CC 設定エディタ (Phase 6 PR-F2)。
 *
 * - GET /api/v2/super/tenants で一覧を取得しテナント選択
 * - GET /api/v2/super/tenants/:id/notification-cc-emails で現在の CC を取得
 * - chips UI で CC を編集 (上限 10、CRLF/カンマ/制御文字/format 拒否、case-insensitive 重複排除)
 * - completionNotificationEnabled Switch
 * - PUT で保存 (差分があるときのみ有効)
 *
 * クライアント側バリデーションは BE `validateSingleEmail`
 * (services/api/src/services/dispatch/cc-email-validator.ts) と同じロジックを軽量ミラー。
 * 詳細は BE で再検証されるので、UI は「明らかに弾けるもの」のみ。BE と divergence させない。
 *
 * Radix-ui Select の RTL テストが煩雑なため、tenant 選択 UI (TenantCcEditor) と
 * CC 編集本体 (TenantCcForm) を分離し、テストは TenantCcForm に集中する。
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  GetTenantNotificationCcResponse,
  PutTenantNotificationCcRequest,
  SuperTenantListResponse,
} from "@lms-279/shared-types";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSuperAdminFetch } from "@/lib/super-api";
import { getDispatchErrorMessage } from "../errorMessage";
import { InlineFeedback } from "./InlineFeedback";

const MAX_CC = DISPATCH_CONSTRAINTS.NOTIFICATION_CC_EMAILS_MAX;

type SuperFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

type ClientValidationReason =
  | "empty"
  | "crlf"
  | "comma"
  | "control"
  | "format"
  | "duplicate";

function reasonMessage(reason: ClientValidationReason): string {
  switch (reason) {
    case "empty":
      return "メールアドレスを入力してください。";
    case "crlf":
      return "改行を含むメールアドレスは登録できません。";
    case "comma":
      return "カンマを含むメールアドレスは登録できません。";
    case "control":
      return "制御文字を含むメールアドレスは登録できません。";
    case "format":
      return "メールアドレスの形式が正しくありません。";
    case "duplicate":
      return "このメールアドレスはすでに登録されています。";
  }
}

/**
 * BE `validateSingleEmail` (cc-email-validator.ts) と同じロジック。
 * 拒否条件: empty / CRLF / カンマ / C0+DEL 制御文字 / format regex 違反。
 * 詳細は BE で再検証されるので UI 側は最低限の門前払いに留める。
 */
export function validateClientCcEmail(
  input: string,
): { ok: true; value: string } | { ok: false; reason: ClientValidationReason } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (/[\r\n]/.test(trimmed)) return { ok: false, reason: "crlf" };
  if (/,/.test(trimmed)) return { ok: false, reason: "comma" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, reason: "control" };
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(trimmed)) {
    return { ok: false, reason: "format" };
  }
  return { ok: true, value: trimmed };
}

/**
 * CC 編集フォーム本体。tenantId を props で受け取り、自分で fetch + 編集 + 保存する。
 * Radix Select の RTL テストを避けるため親 (TenantCcEditor) から分離。
 */
export function TenantCcForm({
  tenantId,
  superFetch,
}: {
  tenantId: string;
  superFetch: SuperFetch;
}) {
  const [config, setConfig] = useState<GetTenantNotificationCcResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [originalEmails, setOriginalEmails] = useState<string[]>([]);
  const [originalEnabled, setOriginalEnabled] = useState<boolean>(true);
  const [emails, setEmails] = useState<string[]>([]);
  const [enabled, setEnabled] = useState<boolean>(true);

  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyLoaded = (data: GetTenantNotificationCcResponse) => {
    setConfig(data);
    setOriginalEmails(data.notificationCcEmails);
    setOriginalEnabled(data.completionNotificationEnabled);
    setEmails(data.notificationCcEmails);
    setEnabled(data.completionNotificationEnabled);
    setDraft("");
    setDraftError(null);
  };

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaveError(null);
    setNotice(null);
    try {
      const data = await superFetch<GetTenantNotificationCcResponse>(
        `/api/v2/super/tenants/${tenantId}/notification-cc-emails`,
      );
      applyLoaded(data);
    } catch (e) {
      setError(getDispatchErrorMessage(e, "CC 設定の取得に失敗しました"));
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, superFetch]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleAdd = () => {
    setDraftError(null);
    if (emails.length >= MAX_CC) {
      setDraftError(`CC は 1 テナントあたり最大 ${MAX_CC} 件まで登録できます。`);
      return;
    }
    const result = validateClientCcEmail(draft);
    if (!result.ok) {
      // 既存 chips は不変 (無効入力でも emails は触らない)
      setDraftError(reasonMessage(result.reason));
      return;
    }
    // case-insensitive 重複排除
    const lowerSet = new Set(emails.map((e) => e.toLowerCase()));
    if (lowerSet.has(result.value.toLowerCase())) {
      setDraftError(reasonMessage("duplicate"));
      return;
    }
    setEmails((prev) => [...prev, result.value]);
    setDraft("");
  };

  const handleRemove = (email: string) => {
    setEmails((prev) => prev.filter((e) => e !== email));
    setDraftError(null);
  };

  const isDirty =
    enabled !== originalEnabled ||
    emails.length !== originalEmails.length ||
    emails.some((e, i) => originalEmails[i] !== e);

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    const body: PutTenantNotificationCcRequest = {
      notificationCcEmails: emails,
      completionNotificationEnabled: enabled,
    };
    try {
      const updated = await superFetch<GetTenantNotificationCcResponse>(
        `/api/v2/super/tenants/${tenantId}/notification-cc-emails`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      applyLoaded(updated);
      setNotice("保存しました。");
    } catch (e) {
      setSaveError(getDispatchErrorMessage(e, "保存に失敗しました"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">CC 設定を読み込み中...</div>;
  }
  if (error) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </div>
        <Button variant="outline" onClick={loadConfig}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (!config) return null;

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-3 text-sm">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={saving}
          aria-label="このテナントへの完了通知を有効化"
        />
        <span>
          {enabled ? "このテナントへの配信 ON" : "このテナントへの配信 OFF"}
        </span>
      </label>

      <p className="text-xs text-muted-foreground">
        テナント代表メール: <span className="font-mono">{config.ownerEmail ?? "（未設定）"}</span>{" "}
        （変更は
        <Link
          href="/super/tenants"
          className="underline underline-offset-2 hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-label="テナント管理画面を開く（代表メールはこの画面から変更）"
        >
          「テナント管理」画面
        </Link>
        から）
      </p>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          追加 CC ({emails.length} / {MAX_CC})
        </label>
        {emails.length === 0 ? (
          <p className="text-xs text-muted-foreground">追加の CC は登録されていません。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid="cc-chips">
            {emails.map((e) => (
              <Badge key={e} variant="secondary" className="gap-1">
                {e}
                <button
                  type="button"
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemove(e)}
                  disabled={saving}
                  aria-label={`${e} を削除`}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            type="text"
            inputMode="email"
            autoComplete="off"
            placeholder="cc@example.com"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (draftError) setDraftError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            disabled={saving || emails.length >= MAX_CC}
            aria-label="追加する CC メール"
          />
          <Button
            variant="outline"
            onClick={handleAdd}
            disabled={
              saving || emails.length >= MAX_CC || draft.trim().length === 0
            }
          >
            追加
          </Button>
        </div>
        {draftError && (
          <p className="text-xs text-destructive" role="alert">
            {draftError}
          </p>
        )}
      </div>

      {saveError && (
        <InlineFeedback tone="error" onDismiss={() => setSaveError(null)}>
          {saveError}
        </InlineFeedback>
      )}
      {notice && (
        <InlineFeedback tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </InlineFeedback>
      )}
      <div>
        <Button onClick={handleSave} disabled={!isDirty || saving}>
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}

/**
 * tenant 一覧 + 選択 UI。本体の編集は TenantCcForm に委譲。
 */
export function TenantCcEditor() {
  const { superFetch } = useSuperAdminFetch();
  const [tenants, setTenants] = useState<SuperTenantListResponse["tenants"]>(
    [],
  );
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError(null);
    try {
      const data = await superFetch<SuperTenantListResponse>(
        "/api/v2/super/tenants",
      );
      setTenants(data.tenants);
    } catch (e) {
      setTenantsError(
        getDispatchErrorMessage(e, "テナント一覧の取得に失敗しました"),
      );
    } finally {
      setTenantsLoading(false);
    }
  }, [superFetch]);

  useEffect(() => {
    loadTenants();
  }, [loadTenants]);

  if (tenantsLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        テナント一覧を読み込み中...
      </div>
    );
  }
  if (tenantsError) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
          {tenantsError}
        </div>
        <Button variant="outline" onClick={loadTenants}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (tenants.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        テナントが存在しません。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-sm font-medium">対象テナント</label>
        <Select
          value={selectedTenantId ?? ""}
          onValueChange={(v) => setSelectedTenantId(v)}
        >
          <SelectTrigger className="w-full" aria-label="対象テナント">
            <SelectValue placeholder="テナントを選択..." />
          </SelectTrigger>
          <SelectContent>
            {tenants.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name} ({t.id})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selectedTenantId && (
        <TenantCcForm
          key={selectedTenantId}
          tenantId={selectedTenantId}
          superFetch={superFetch}
        />
      )}
    </div>
  );
}
