/**
 * DryRunPreview (Phase 4 α-7-FE) のテスト。
 *
 * 観点:
 *   - discriminated union narrowing (progress / completion lane 別表示)
 *   - skip 内訳バー / scaleTriggerExceeded warning / completionMessageBodyLength null
 *   - error 表示 (ApiError、429 専用メッセージ含む)
 *   - empty state / disabled state (AC-α7-11)
 *   - loading 中の aria-busy / button disable (AC-α7-12)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  CompletionDryRunResult,
  ProgressDryRunResult,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { DryRunPreview } from "../DryRunPreview";

const NOW = "2026-06-04T10:00:00.000Z";

function makeProgressResult(
  partial: Partial<ProgressDryRunResult> = {},
): ProgressDryRunResult {
  return {
    lane: "progress",
    evaluatedAt: NOW,
    settingsLoaded: true,
    settingsSnapshot: {
      progressReportEnabled: true,
      scheduleDaysOfWeek: [1, 4],
      scheduleHourJst: 9,
      signatureName: "DXcollege運営スタッフ",
    },
    tenantsScanned: 1,
    tenantsSummary: [
      {
        tenantId: "tenant-a",
        skipped: false,
        usersScanned: 10,
        candidateCount: 10,
        invalidEmailCount: 1,
        completedCount: 2,
        ineligibleCount: 0,
        wouldSendCount: 7,
        ccCount: 2,
      },
    ],
    totalWouldSendCount: 7,
    totalCcCount: 14,
    estimatedDurationMs: 2000,
    estimatedPdfSizeKbRange: { min: 150, typical: 350, max: 1200 },
    scaleTriggerExceeded: false,
    ...partial,
  };
}

function makeCompletionResult(
  partial: Partial<CompletionDryRunResult> = {},
): CompletionDryRunResult {
  return {
    lane: "completion",
    evaluatedAt: NOW,
    settingsLoaded: true,
    settingsSnapshot: {
      enabled: true,
      scheduleDaysOfWeek: [1, 4],
      scheduleHourJst: 9,
      signatureName: "DXcollege運営スタッフ",
      completionMessageBodyLength: 50,
    },
    tenantsScanned: 1,
    tenantsSummary: [
      {
        tenantId: "tenant-a",
        skipped: false,
        usersScanned: 10,
        eligibleCount: 1,
        invalidEmailCount: 0,
      },
    ],
    wouldNotifyCount: 1,
    wouldNotify: [],
    ...partial,
  };
}

describe("DryRunPreview (progress)", () => {
  it("初期状態 (result=null, error=null, isLoading=false) で取得ボタンと案内のみ表示", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={null}
        isLoading={false}
        error={null}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /進捗レポート 配信プレビューを再取得/ }),
    ).toBeEnabled();
    expect(
      screen.getByText(/「プレビューを取得」ボタンを押すと/),
    ).toBeInTheDocument();
  });

  it("isLoading=true で button disabled + aria-busy", () => {
    const { container } = render(
      <DryRunPreview
        lane="progress"
        result={null}
        isLoading={true}
        error={null}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /進捗レポート 配信プレビューを再取得/ })).toBeDisabled();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("progress result の主要 metric を表示する (totalWouldSendCount / PDF サイズ範囲)", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    // 送信予定数 / CC 延べ件数 ラベルが存在 (値はテーブル内とも重複するため重複許容)
    expect(screen.getByText("送信予定数")).toBeInTheDocument();
    expect(screen.getByText("CC 延べ件数")).toBeInTheDocument();
    expect(screen.getAllByText("7").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("14").length).toBeGreaterThanOrEqual(1);
    // PDF サイズ範囲は固有テキスト
    expect(screen.getByText("150–1200 KB")).toBeInTheDocument();
  });

  it("scaleTriggerExceeded=true で 300 名超 warning が出る (ADR-039)", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({ scaleTriggerExceeded: true })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/scale trigger 超過/)).toBeInTheDocument();
    expect(screen.getByText(/Cloud Tasks 移行の検討/)).toBeInTheDocument();
  });

  it("settingsLoaded=false で default 値プレビュー warning を表示", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({
          settingsLoaded: false,
          settingsSnapshot: null,
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/配信設定が未保存/)).toBeInTheDocument();
  });

  it("skip テナントは skipReason 日本語ラベルを表示する", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({
          tenantsSummary: [
            {
              tenantId: "tenant-b",
              skipped: true,
              skipReason: "progress_report_disabled",
              usersScanned: 0,
              candidateCount: 0,
              invalidEmailCount: 0,
              completedCount: 0,
              ineligibleCount: 0,
              wouldSendCount: 0,
              ccCount: 0,
            },
          ],
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("進捗レポート OFF")).toBeInTheDocument();
  });
});

describe("DryRunPreview (completion)", () => {
  it("completion lane の metric を表示する (wouldNotifyCount / 本文文字数)", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("送信予定数")).toBeInTheDocument();
    expect(screen.getByText("50 文字")).toBeInTheDocument();
  });

  it("completionMessageBodyLength=null で「本文未設定」warning を表示 (F3)", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult({
          settingsSnapshot: {
            enabled: true,
            scheduleDaysOfWeek: [1],
            scheduleHourJst: 9,
            signatureName: "DXcollege運営スタッフ",
            completionMessageBodyLength: null,
          },
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("未設定")).toBeInTheDocument();
    expect(screen.getByText(/完了通知本文が未設定です/)).toBeInTheDocument();
  });

  it("wouldNotify が空のとき MIME プレビュー section を表示しない", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult({ wouldNotify: [] })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByText(/送信内容プレビュー/)).not.toBeInTheDocument();
  });

  it("wouldNotify が 1 件以上のとき MIME プレビュー section を表示", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult({
          wouldNotifyCount: 1,
          wouldNotify: [
            {
              tenantId: "tenant-a",
              userId: "user-1",
              userEmail: "user@example.com",
              userName: "山田太郎",
              courseIdsSnapshot: ["c1", "c2"],
              mimePreview: {
                from: "DXcollege運営スタッフ <dxcollege@279279.net>",
                to: "user@example.com",
                cc: ["owner@tenant.example"],
                subject: "【DXcollege】受講修了のお知らせ",
                body: "山田太郎 様\n\n受講お疲れ様でした。\n",
              },
            },
          ],
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/送信内容プレビュー \(1 件\)/)).toBeInTheDocument();
  });
});

describe("DryRunPreview (error states)", () => {
  it("ApiError (status=429) のとき rate-limit メッセージを追加表示", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={null}
        isLoading={false}
        error={
          new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many dry-run requests.")
        }
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/プレビュー取得に失敗しました/)).toBeInTheDocument();
    expect(screen.getByText(/連続リクエストが多すぎます/)).toBeInTheDocument();
  });

  it("ApiError (status=403) のとき権限エラーを日本語で表示", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={null}
        isLoading={false}
        error={new ApiError(403, "forbidden", "super-admin only")}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/この操作を行う権限がありません/)).toBeInTheDocument();
  });
});
