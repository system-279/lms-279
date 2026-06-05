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
import { afterEach, describe, it, expect, vi } from "vitest";
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

describe("DryRunPreview (AC-α7-04 全 skipReason 網羅)", () => {
  // progress lane の 4 skipReason すべて表示確認
  it.each([
    ["tenant_doc_not_found", "テナントドキュメント未検出"],
    ["tenant_not_active", "テナント無効"],
    ["progress_report_disabled", "進捗レポート OFF"],
    ["no_published_courses", "公開講座なし"],
  ] as const)(
    "progress lane skipReason=%s で日本語ラベル『%s』が表示される",
    (reason, label) => {
      render(
        <DryRunPreview
          lane="progress"
          result={makeProgressResult({
            tenantsSummary: [
              {
                tenantId: `tenant-${reason}`,
                skipped: true,
                skipReason: reason,
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
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  // completion lane の 2 skipReason すべて表示確認
  it.each([
    ["tenant_completion_notification_disabled", "完了通知 OFF"],
    ["no_published_courses", "公開講座なし"],
  ] as const)(
    "completion lane skipReason=%s で日本語ラベル『%s』が表示される",
    (reason, label) => {
      render(
        <DryRunPreview
          lane="completion"
          result={makeCompletionResult({
            tenantsSummary: [
              {
                tenantId: `tenant-${reason}`,
                skipped: true,
                skipReason: reason,
                usersScanned: 0,
                eligibleCount: 0,
                invalidEmailCount: 0,
              },
            ],
          })}
          isLoading={false}
          error={null}
          lastFetchedAt={NOW}
          onRefresh={vi.fn()}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );
});

describe("DryRunPreview (AC-α7-09 a11y semantic)", () => {
  it("再取得 button は明示的 aria-label を持つ (lane 別)", () => {
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
      screen.getByRole("button", { name: "進捗レポート 配信プレビューを再取得" }),
    ).toBeInTheDocument();
  });

  it("error 表示時に role='alert' が配置される (critical)", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={null}
        isLoading={false}
        error={new ApiError(500, "internal_error", "boom")}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("プレビュー取得に失敗しました");
  });

  it("scaleTriggerExceeded の警告は role='alert' (緊急性高)", () => {
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
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((el) => /scale trigger 超過/.test(el.textContent ?? ""))).toBe(
      true,
    );
  });

  it("settingsLoaded=false の警告は role='status' (info)", () => {
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
    const statuses = screen.getAllByRole("status");
    expect(statuses.some((el) => /配信設定が未保存/.test(el.textContent ?? ""))).toBe(
      true,
    );
  });

  it("再取得 button は focusable (tabIndex で keyboard navigation 可能)", () => {
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
    const button = screen.getByRole("button", {
      name: /進捗レポート 配信プレビューを再取得/,
    });
    // button 要素は default で focusable (tabIndex 0)、disabled=true で除外される
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();
  });

  it("table の <th> 全てに scope='col' 属性が付く", () => {
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
    const ths = screen.getAllByRole("columnheader");
    ths.forEach((th) => {
      expect(th).toHaveAttribute("scope", "col");
    });
  });

  it("table caption は sr-only で読み上げ対応 (lane 別)", () => {
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
    expect(screen.getByText("完了通知 配信予定 テナント別内訳")).toBeInTheDocument();
  });
});

describe("DryRunPreview (AC-α7-11 empty/disabled state)", () => {
  it("(c) progress lane disabled (progressReportEnabled=false) で OFF 警告表示", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({
          settingsSnapshot: {
            progressReportEnabled: false,
            scheduleDaysOfWeek: [1],
            scheduleHourJst: 9,
            signatureName: "DXcollege運営スタッフ",
          },
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/このレーンは現在 OFF です/)).toBeInTheDocument();
  });

  it("(c) completion lane disabled (enabled=false) で OFF 警告表示", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult({
          settingsSnapshot: {
            enabled: false,
            scheduleDaysOfWeek: [1],
            scheduleHourJst: 9,
            signatureName: "DXcollege運営スタッフ",
            completionMessageBodyLength: 49,
          },
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/このレーンは現在 OFF です/)).toBeInTheDocument();
  });

  it("(d) scheduleDaysOfWeek=[] で曜日未選択警告表示", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({
          settingsSnapshot: {
            progressReportEnabled: true,
            scheduleDaysOfWeek: [],
            scheduleHourJst: 9,
            signatureName: "DXcollege運営スタッフ",
          },
        })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/配信曜日が選択されていません/),
    ).toBeInTheDocument();
  });

  it("(a) completion wouldNotify=[] で「送信予定の受講者はいません」明示", () => {
    render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult({ wouldNotifyCount: 0, wouldNotify: [] })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("送信予定の受講者はいません。")).toBeInTheDocument();
  });
});

describe("DryRunPreview (AC-α7-13 data freshness)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evaluatedAt は JST format で表示される (Asia/Tokyo)", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({ evaluatedAt: "2026-06-04T10:00:00.000Z" })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    // UTC 10:00 → JST 19:00
    expect(screen.getByText(/評価時刻:.*19:00:00.*\(JST\)/)).toBeInTheDocument();
  });

  it("lastFetchedAt 6 分前で stale 警告表示 (5 分閾値超え)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T20:00:00.000Z"));
    const sixMinAgo = new Date("2026-06-04T19:54:00.000Z").toISOString();
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={sixMinAgo}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/結果が古い可能性があります/)).toBeInTheDocument();
  });

  it("lastFetchedAt 4 分前は stale 警告なし (5 分閾値以内、境界値)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T20:00:00.000Z"));
    const fourMinAgo = new Date("2026-06-04T19:56:00.000Z").toISOString();
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={fourMinAgo}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByText(/結果が古い可能性があります/)).not.toBeInTheDocument();
  });

  it("lastFetchedAt=null は stale 警告なし (まだ未取得)", () => {
    render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByText(/結果が古い可能性があります/)).not.toBeInTheDocument();
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
