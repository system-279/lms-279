"use client";

/**
 * スーパー管理者: 自動完了通知 配信設定ページ (Phase 6 PR-F1)。
 *
 * - GET /api/v2/super/dispatch/settings で初期値ロード (doc 未作成時は default)
 * - enabled (kill switch) / スケジュール / 署名・本文を編集し PUT で保存 (version 楽観ロック)
 * - 409 (version 競合) は最新値を再取得してフォームへ反映 + 警告 (AC-23)
 * - ドライラン / テスト送信を実行
 *
 * senderEmail は env 由来 (read-only)。テナント別 CC / 監査ログ / run 履歴は PR-F2。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GetDispatchSettingsResponse,
  PutDispatchSettingsRequest,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { useSuperAdminFetch } from "@/lib/super-api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScheduleEditor } from "./components/ScheduleEditor";
import { MessageBodyEditor } from "./components/MessageBodyEditor";
import { DryRunPanel } from "./components/DryRunPanel";
import { TestSendButton } from "./components/TestSendButton";
import { getDispatchErrorMessage } from "./errorMessage";

interface FormState {
  enabled: boolean;
  scheduleDaysOfWeek: number[];
  scheduleHourJst: number;
  signatureName: string;
  completionMessageBody: string;
  version: number;
  senderEmail: string;
}

function toFormState(s: GetDispatchSettingsResponse): FormState {
  return {
    enabled: s.enabled,
    scheduleDaysOfWeek: s.scheduleDaysOfWeek,
    scheduleHourJst: s.scheduleHourJst,
    signatureName: s.signatureName,
    completionMessageBody: s.completionMessageBody,
    version: s.version,
    senderEmail: s.senderEmail,
  };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border p-4 space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export default function DispatchSettingsPage() {
  const { superFetch } = useSuperAdminFetch();
  const superFetchRef = useRef(superFetch);
  superFetchRef.current = superFetch;

  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await superFetchRef.current<GetDispatchSettingsResponse>(
        "/api/v2/super/dispatch/settings",
      );
      setForm(toFormState(data));
    } catch (e) {
      setError(getDispatchErrorMessage(e, "設定の取得に失敗しました"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    const body: PutDispatchSettingsRequest = {
      enabled: form.enabled,
      scheduleDaysOfWeek: form.scheduleDaysOfWeek,
      scheduleHourJst: form.scheduleHourJst,
      signatureName: form.signatureName,
      completionMessageBody: form.completionMessageBody,
      version: form.version,
    };
    try {
      const updated =
        await superFetchRef.current<GetDispatchSettingsResponse>(
          "/api/v2/super/dispatch/settings",
          { method: "PUT", body: JSON.stringify(body) },
        );
      setForm(toFormState(updated));
      setNotice("保存しました。");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // version 競合: 最新値を再取得してフォームへ反映 (AC-23)
        await loadSettings();
        setSaveError(
          "他の管理者が設定を更新したため、最新の値を読み込みました。内容を確認して再度保存してください。",
        );
      } else {
        setSaveError(getDispatchErrorMessage(e, "保存に失敗しました"));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-muted-foreground">読み込み中...</div>;
  }
  if (error) {
    return (
      <div className="space-y-3">
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
        <Button variant="outline" onClick={loadSettings}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (!form) return null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">完了通知 配信設定</h1>
        <p className="text-sm text-muted-foreground">
          全コース 100% 完了した受講者へ自動送信する完了通知の設定です。
        </p>
      </div>

      <Section
        title="配信の有効化"
        description="無効にすると次回 cron 起動時に即座に配信が停止します (kill switch)。"
      >
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={form.enabled}
            onCheckedChange={(v) => setForm({ ...form, enabled: v })}
            disabled={saving}
            aria-label="配信を有効化"
          />
          <span>{form.enabled ? "配信 ON" : "配信 OFF"}</span>
        </label>
        <p className="text-xs text-muted-foreground">
          送信元: <span className="font-mono">{form.senderEmail}</span> (環境設定、変更不可)
        </p>
      </Section>

      <Section title="配信スケジュール">
        <ScheduleEditor
          daysOfWeek={form.scheduleDaysOfWeek}
          hourJst={form.scheduleHourJst}
          onChange={(next) =>
            setForm({
              ...form,
              scheduleDaysOfWeek: next.daysOfWeek,
              scheduleHourJst: next.hourJst,
            })
          }
          disabled={saving}
        />
      </Section>

      <Section title="メール署名・本文">
        <MessageBodyEditor
          signatureName={form.signatureName}
          completionMessageBody={form.completionMessageBody}
          onChange={(next) =>
            setForm({
              ...form,
              signatureName: next.signatureName,
              completionMessageBody: next.completionMessageBody,
            })
          }
          disabled={saving}
        />
      </Section>

      {saveError && (
        <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
          {saveError}
        </div>
      )}
      {notice && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "保存中..." : "保存"}
        </Button>
        <span className="text-xs text-muted-foreground">version {form.version}</span>
      </div>

      <Section
        title="ドライラン"
        description="次回配信される対象を送信せずに確認します。"
      >
        <DryRunPanel />
      </Section>

      <Section
        title="テスト送信"
        description="設定中の送信経路を、自分宛の固定ダミーメールで確認します。"
      >
        <TestSendButton />
      </Section>
    </div>
  );
}
