"use client";

/**
 * dispatch dry-run プレビューコンポーネント (Phase 4 α-7-FE、AC-α7-01〜13)。
 *
 * 設計:
 *   - **discriminated union narrowing**: props.result は
 *     `ProgressDryRunResult | CompletionDryRunResult` で、`result.lane` で分岐し
 *     lane 固有 field (estimatedPdfSizeKbRange / wouldNotify 等) に安全アクセス。
 *   - **空状態 / disabled** の表示 (AC-α7-11):
 *     - `settingsLoaded === false`: 「配信設定が未保存」warning (`PreviewHeader` 内)。
 *       `settingsSnapshot === null` の場合もこの分岐に集約される。
 *     - `tenantsSummary === []`: 「対象テナントがありません」 (`TenantSummaryTable` 内)
 *     - completion lane `wouldNotify === []`: 「送信予定の受講者はいません」
 *     - completion lane `completionMessageBodyLength === null`: 「本文未設定」warning
 *   - **aria-live="polite"** で状態更新を読み上げ (AC-α7-09)。
 *   - **responsive**: `md:` breakpoint で table 表示を縦並びに切替 (AC-α7-10)。
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク D1
 *   - useDryRun (../hooks/useDryRun.ts): 取得 hook
 */

import type {
  CompletionDryRunResult,
  CompletionDryRunSkipReason,
  CompletionDryRunTarget,
  CompletionDryRunTenantSummary,
  DispatchLane,
  ProgressDryRunResult,
  ProgressDryRunSkipReason,
  ProgressDryRunTenantSummary,
} from "@lms-279/shared-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApiError } from "@/lib/api";
import { getDispatchErrorMessage } from "../errorMessage";

export interface DryRunPreviewProps {
  lane: DispatchLane;
  result: ProgressDryRunResult | CompletionDryRunResult | null;
  isLoading: boolean;
  error: ApiError | null;
  /** FE 時計の最終取得時刻 (連打抑止 UX 用) */
  lastFetchedAt: string | null;
  onRefresh: () => void;
}

const PROGRESS_SKIP_LABEL: Record<ProgressDryRunSkipReason, string> = {
  tenant_doc_not_found: "テナントドキュメント未検出",
  tenant_not_active: "テナント無効",
  progress_report_disabled: "進捗レポート OFF",
  no_published_courses: "公開講座なし",
};

const COMPLETION_SKIP_LABEL: Record<CompletionDryRunSkipReason, string> = {
  tenant_completion_notification_disabled: "完了通知 OFF",
  no_published_courses: "公開講座なし",
};

function formatJst(isoString: string): string {
  // ADR-029 (UTC 保存 / JST 表示) — `evaluatedAt` は ISO8601 UTC
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch {
    return isoString;
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function DryRunPreview(props: DryRunPreviewProps) {
  const { lane, result, isLoading, error, lastFetchedAt, onRefresh } = props;

  return (
    <div
      className="space-y-3"
      aria-live="polite"
      aria-busy={isLoading}
      data-testid={`dry-run-preview-${lane}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label={
            lane === "progress"
              ? "進捗レポート 配信プレビューを再取得"
              : "完了通知 配信プレビューを再取得"
          }
        >
          {isLoading ? "取得中..." : "プレビューを取得"}
        </Button>
        {lastFetchedAt && (
          <span className="text-xs text-muted-foreground">
            最終取得: {formatJst(lastFetchedAt)}
          </span>
        )}
      </div>

      {error && (
        <div
          className="rounded-md border border-l-4 border-l-rose-500 bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950/60 dark:text-rose-100"
          role="alert"
        >
          <p className="font-medium">プレビュー取得に失敗しました</p>
          <p className="mt-1 text-xs">
            {getDispatchErrorMessage(error, error.message)}
          </p>
          {error.status === 429 && (
            <p className="mt-1 text-xs">
              連続リクエストが多すぎます。1 分後に再試行してください。
            </p>
          )}
        </div>
      )}

      {result && !error && (
        <div className="space-y-3">
          <PreviewHeader result={result} />
          {result.lane === "progress" ? (
            <ProgressPreview result={result} />
          ) : (
            <CompletionPreview result={result} />
          )}
        </div>
      )}

      {!result && !error && !isLoading && (
        <p className="text-xs text-muted-foreground">
          「プレビューを取得」ボタンを押すと、現在の設定で配信される予定の宛先・件数を計算します（送信は行いません）。
        </p>
      )}
    </div>
  );
}

function PreviewHeader({
  result,
}: {
  result: ProgressDryRunResult | CompletionDryRunResult;
}) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>評価時刻: {formatJst(result.evaluatedAt)} (JST)</p>
      <p>
        対象テナント数: <span className="font-medium">{result.tenantsScanned}</span>
      </p>
      {!result.settingsLoaded && (
        <p className="text-amber-700 dark:text-amber-400" role="status">
          ⚠️ 配信設定が未保存です。プレビューは default 値で計算されています。
        </p>
      )}
    </div>
  );
}

function ProgressPreview({ result }: { result: ProgressDryRunResult }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <Metric label="送信予定数" value={result.totalWouldSendCount} />
        <Metric label="CC 延べ件数" value={result.totalCcCount} />
        <Metric
          label="推定処理時間"
          value={formatDurationMs(result.estimatedDurationMs)}
        />
        <Metric
          label="PDF 推定サイズ"
          value={`${result.estimatedPdfSizeKbRange.min}–${result.estimatedPdfSizeKbRange.max} KB`}
        />
      </div>

      {result.scaleTriggerExceeded && (
        <div
          className="rounded-md border border-l-4 border-l-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100"
          role="alert"
        >
          <p className="font-medium">⚠️ scale trigger 超過 (ADR-039)</p>
          <p className="mt-1 text-xs">
            送信予定数が 300 名を超えています。Cloud Tasks 移行の検討が必要です。
          </p>
        </div>
      )}

      <TenantSummaryTable
        lane="progress"
        summaries={result.tenantsSummary}
      />
    </div>
  );
}

function CompletionPreview({ result }: { result: CompletionDryRunResult }) {
  const completionMessageBodyLength =
    result.settingsSnapshot?.completionMessageBodyLength ?? null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
        <Metric label="送信予定数" value={result.wouldNotifyCount} />
        <Metric label="対象テナント数" value={result.tenantsScanned} />
        <Metric
          label="本文文字数"
          value={
            completionMessageBodyLength === null
              ? "未設定"
              : `${completionMessageBodyLength} 文字`
          }
        />
      </div>

      {completionMessageBodyLength === null && (
        <div
          className="rounded-md border border-l-4 border-l-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100"
          role="status"
        >
          <p>
            ⚠️ 完了通知本文が未設定です。「メール署名・本文」セクションで保存してからプレビューしてください。
          </p>
        </div>
      )}

      <TenantSummaryTable
        lane="completion"
        summaries={result.tenantsSummary}
      />

      {result.wouldNotify.length > 0 ? (
        <MimePreviewList targets={result.wouldNotify} />
      ) : (
        // Codex review C2 (PR #519、2026-06-04): wouldNotify=[] を「単に表示しない」
        // ではなく「送信予定者なし」として明示 (AC-α7-11)。
        <p className="text-xs text-muted-foreground" role="status">
          送信予定の受講者はいません。
        </p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-md border bg-card p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function TenantSummaryTable({
  lane,
  summaries,
}: {
  lane: DispatchLane;
  summaries:
    | ProgressDryRunTenantSummary[]
    | CompletionDryRunTenantSummary[];
}) {
  if (summaries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        対象テナントがありません。
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">
          {lane === "progress"
            ? "進捗レポート 配信予定 テナント別内訳"
            : "完了通知 配信予定 テナント別内訳"}
        </caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-1.5 pr-2 font-medium">テナント</th>
            <th scope="col" className="py-1.5 pr-2 font-medium">状態</th>
            {lane === "progress" ? (
              <>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">候補</th>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">送信</th>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">完了済</th>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">無効email</th>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">不適格</th>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">CC</th>
              </>
            ) : (
              <>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">送信予定</th>
                <th scope="col" className="py-1.5 pr-2 text-right font-medium">無効email</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => (
            <SummaryRow key={s.tenantId} lane={lane} summary={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryRow({
  lane,
  summary,
}: {
  lane: DispatchLane;
  summary: ProgressDryRunTenantSummary | CompletionDryRunTenantSummary;
}) {
  const skipLabel = summary.skipped
    ? lane === "progress"
      ? PROGRESS_SKIP_LABEL[
          (summary.skipReason ?? "tenant_doc_not_found") as ProgressDryRunSkipReason
        ]
      : COMPLETION_SKIP_LABEL[
          (summary.skipReason ??
            "tenant_completion_notification_disabled") as CompletionDryRunSkipReason
        ]
    : null;
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-1 pr-2 font-mono text-[11px]">{summary.tenantId}</td>
      <td className="py-1 pr-2">
        {summary.skipped ? (
          <Badge variant="secondary">{skipLabel ?? "skip"}</Badge>
        ) : (
          <Badge variant="outline">対象</Badge>
        )}
      </td>
      {lane === "progress" ? (
        <ProgressSummaryCells
          summary={summary as ProgressDryRunTenantSummary}
        />
      ) : (
        <CompletionSummaryCells
          summary={summary as CompletionDryRunTenantSummary}
        />
      )}
    </tr>
  );
}

function ProgressSummaryCells({
  summary,
}: {
  summary: ProgressDryRunTenantSummary;
}) {
  return (
    <>
      <td className="py-1 pr-2 text-right tabular-nums">
        {summary.candidateCount}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums font-medium">
        {summary.wouldSendCount}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">
        {summary.completedCount}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">
        {summary.invalidEmailCount}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">
        {summary.ineligibleCount}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">{summary.ccCount}</td>
    </>
  );
}

function CompletionSummaryCells({
  summary,
}: {
  summary: CompletionDryRunTenantSummary;
}) {
  return (
    <>
      <td className="py-1 pr-2 text-right tabular-nums font-medium">
        {summary.eligibleCount}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">
        {summary.invalidEmailCount}
      </td>
    </>
  );
}

function MimePreviewList({ targets }: { targets: CompletionDryRunTarget[] }) {
  return (
    <details className="rounded-md border bg-card p-2">
      <summary className="cursor-pointer text-sm font-medium">
        送信内容プレビュー ({targets.length} 件)
      </summary>
      <ul className="mt-2 space-y-2">
        {targets.map((target) => (
          <li
            key={`${target.tenantId}:${target.userId}`}
            className="rounded border bg-background p-2 text-xs"
          >
            <p className="font-medium">
              {target.userName}{" "}
              <span className="text-muted-foreground">
                &lt;{target.userEmail}&gt;
              </span>
            </p>
            <p className="mt-0.5 text-muted-foreground">
              テナント: {target.tenantId} / 講座 {target.courseIdsSnapshot.length} 件
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground">
                MIME プレビュー
              </summary>
              <dl className="mt-1 space-y-0.5 text-[11px]">
                <Row label="From" value={target.mimePreview.from} />
                <Row label="To" value={target.mimePreview.to} />
                {target.mimePreview.cc.length > 0 && (
                  <Row label="Cc" value={target.mimePreview.cc.join(", ")} />
                )}
                <Row label="Subject" value={target.mimePreview.subject} />
              </dl>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px]">
                {target.mimePreview.body}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-12 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}
