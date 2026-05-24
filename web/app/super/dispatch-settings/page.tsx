"use client";

/**
 * スーパー管理者: 自動完了通知 配信設定ページ (Phase 6 PR-F1 + PR-F2)。
 *
 * - GET /api/v2/super/dispatch/settings で初期値ロード (doc 未作成時は default)
 * - enabled (kill switch) / スケジュール / 署名・本文を編集し PUT で保存 (version 楽観ロック)
 * - 409 (version 競合) は最新値を再取得してフォームへ反映 + 警告 (AC-23)
 * - ドライラン / テスト送信を実行
 * - テナント別 CC 設定 (PR-F2)
 * - 監査ログ / run 履歴 (PR-F2)
 *
 * senderEmail は env 由来 (read-only)。F2 component (TenantCcEditor / AuditLogTable /
 * RunHistoryTable) は本ページの settings ロード状態と独立に自分で fetch するため、
 * settings ロード失敗時でも他 Section を閲覧できる。
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
// 2026-05-24 PR-B: テスト送信 / ドライランボタンの UI は撤廃。
// 代替の admin SDK workflow:
//   - dry-run: .github/workflows/dispatch-dry-run.yml
//   - test-send: .github/workflows/smoke-dwd-gmail-send.yml (SendAs smoke)
import { TenantCcEditor } from "./components/TenantCcEditor";
import { AuditLogTable } from "./components/AuditLogTable";
import { RunHistoryTable } from "./components/RunHistoryTable";
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
  hint,
  children,
}: {
  title: string;
  description?: string;
  /** title の右に表示する `?` アイコンの hover 補足（native title 属性で表示） */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border p-4 space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold flex items-center gap-1.5">
          {title}
          {hint && (
            <span
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-muted-foreground/50 text-[10px] font-normal text-muted-foreground"
              title={hint}
              aria-label={`補足: ${hint}`}
              role="img"
            >
              ?
            </span>
          )}
        </h2>
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
    setSaveError(null); // 前回の保存エラーを持ち越さない
    setNotice(null);
    try {
      const data = await superFetchRef.current<GetDispatchSettingsResponse>(
        "/api/v2/super/dispatch/settings",
      );
      setForm(toFormState(data));
    } catch (e) {
      // 早期 return を廃止し条件 render に変更したので、form を null 化しないと
      // 前回成功時の値が残ったまま error と同時表示される。AC-23 の 409 reload は
      // 409 を catch する前に loadSettings の try ブロックに入るため、新値を取得して
      // setForm が成功すれば form は最新値で上書きされる。
      setForm(null);
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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">完了通知 配信設定</h1>
        <p className="text-sm text-muted-foreground">
          全コース 100% 完了した受講者へ自動送信する完了通知の設定です。
        </p>
      </div>

      {/* F1: settings (ロード/エラー時は他 Section と独立に inline 表示) */}
      {loading && (
        <div className="text-muted-foreground">読み込み中...</div>
      )}
      {error && (
        <div className="space-y-3">
          <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
            {error}
          </div>
          <Button variant="outline" onClick={loadSettings}>
            再読み込み
          </Button>
        </div>
      )}

      {form && (
        <>
          <Section
            title="配信の有効化"
            description="OFF にすると、次の自動チェック時（最大 60 分以内）から配信が止まります。すでに送信済みのメールは取り消せません。"
            hint="ON にしても即座に送信は始まりません。次の自動チェック（最大 60 分以内）で、配信曜日・時刻条件を満たした時にだけ送信されます。OFF にした場合も同様に、次の自動チェックから停止します。"
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
              送信元アドレス: <span className="font-mono">{form.senderEmail}</span>（システム固定。変更できません）
            </p>
          </Section>

          <Section
            title="配信スケジュール"
            hint="ここで選んだ曜日と時刻台のときに、システムが自動的に配信処理を実行します。例: 月曜・09:00 を選ぶと、毎週月曜の 09:00〜09:59 の間に、自動チェックのタイミングで送信されます。曜日を 1 つも選ばないと配信されません。"
          >
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

          <Section
            title="メール署名・本文"
            hint="ここで編集した内容が、配信される完了通知メールに使われます。右側のプレビューで実際の見え方を確認できます。本文と署名を編集したあとは、必ずページ下の「保存」ボタンを押してください。"
          >
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

        </>
      )}

      {/* F2: settings の loading/error と独立に表示。1 つの Section の取得失敗が他に波及しない */}
      <Section
        title="テナントごとの CC 追加設定"
        description="完了通知メールに CC として追加するメールアドレスを、テナントごとに設定します（テナントあたり最大 10 件まで）。"
      >
        <TenantCcEditor />
      </Section>

      <Section
        title="操作・配信の記録"
        description="設定変更・配信処理・送信エラーなどの記録です（365 日間保存）。"
        hint="「誰がいつ何を行ったか」「個々のメール送信が成功したか失敗したか」を後から確認するための記録です。送信失敗が起きた時の原因調査や、設定をいつ誰が変えたかの確認に使います。下の「自動配信の実行履歴」は、1 回の自動チェック処理ごとの集計結果なので、用途が異なります。"
      >
        <AuditLogTable />
      </Section>

      <Section
        title="自動配信の実行履歴"
        description="1 時間おきに自動的に動く配信処理の結果一覧です（365 日間保存）。"
        hint="1 時間ごとに自動的に動く配信チェック処理が、何件のテナント・受講者を処理し、何件送信・スキップ・失敗したかをまとめた結果一覧です。日々の運用状況の把握に使います。個別のメール 1 通ずつの結果は上の「操作・配信の記録」で確認できます。"
      >
        <RunHistoryTable />
      </Section>
    </div>
  );
}
