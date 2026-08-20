/**
 * DryRunPreview (Phase 4 α-7-FE) のテスト。
 *
 * 観点:
 *   - discriminated union narrowing (progress / completion lane 別表示)
 *   - skip 内訳バー / scaleTriggerExceeded warning / completionMessageBodyLength null
 *   - error 表示 (ApiError、429 専用メッセージ含む)
 *   - empty state / disabled state (AC-α7-11)
 *   - loading 中の aria-busy / button disable (AC-α7-12)
 *
 * Issue #584 戦略見直し (2026-08-20、docs/adr/ADR-041-dry-run-e2e-strategy-revision.md):
 *   AC-α7-09/10/12 の検証方法を「Playwright」から「コンポーネント/統合テスト」へ変更した際の
 *   追加分。AC-09 は jest-axe による自動 a11y 違反検出、AC-12 は実 hook 結合での連打防止、
 *   AC-10 は jsdom の限界内での Tailwind クラス存在チェック (弱い代替、下記コメント参照)。
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import type {
  CompletionDryRunResult,
  DispatchLane,
  ProgressDryRunResult,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { DryRunPreview } from "../DryRunPreview";
import { useDryRun } from "../../hooks/useDryRun";

expect.extend(toHaveNoViolations);

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

function DryRunPreviewLive({ lane }: { lane: DispatchLane }) {
  const dr = useDryRun(lane);
  return (
    <DryRunPreview
      lane={lane}
      result={dr.result}
      isLoading={dr.isLoading}
      error={dr.error}
      lastFetchedAt={dr.lastFetchedAt}
      onRefresh={() => void dr.refresh()}
    />
  );
}

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

describe("DryRunPreview (AC-α7-12 request control、実 hook 結合)", () => {
  afterEach(() => {
    superFetchMock.mockReset();
  });

  it("再取得ボタンを連打しても superFetch は 1 回しか呼ばれない (FE dedupe + BE single-flight の一対設計)。resolve 後の再クリックでは 2 回目が正しく発火する (pr-test-analyzer 指摘: dedupe 解除の恒久ロックを防ぐ回帰確認)", async () => {
    let resolveFetch: ((value: ProgressDryRunResult) => void) | undefined;
    superFetchMock.mockImplementationOnce(
      () =>
        new Promise<ProgressDryRunResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    superFetchMock.mockResolvedValueOnce(
      makeProgressResult({ totalWouldSendCount: 9 }),
    );

    render(<DryRunPreviewLive lane="progress" />);
    const button = screen.getByRole("button", {
      name: "進捗レポート 配信プレビューを再取得",
    });

    // in-flight のまま連打 (useDryRun.refresh() の abortRef dedupe は
    // 状態更新を待たず同期的に効くため、isLoading 反映前の連打でも 1 回に収束する)
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(superFetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    await act(async () => {
      resolveFetch?.(makeProgressResult());
      await Promise.resolve();
    });

    expect(button).toBeEnabled();

    // resolve 後の再クリックで abortRef が正しく解除され、2 回目の refresh が
    // 発火することを確認する (dedupe が誤って恒久ロックしていないかの回帰確認)
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(superFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("DryRunPreview (AC-α7-09 a11y 自動検出、jest-axe)", () => {
  it("初期状態 (result=null) に axe 違反がない", async () => {
    const { container } = render(
      <DryRunPreview
        lane="progress"
        result={null}
        isLoading={false}
        error={null}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("結果表示状態 (テーブル/metric込み) に axe 違反がない", async () => {
    const { container } = render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult({ scaleTriggerExceeded: true })}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("error 表示状態に axe 違反がない", async () => {
    const { container } = render(
      <DryRunPreview
        lane="completion"
        result={null}
        isLoading={false}
        error={new ApiError(500, "internal_error", "boom")}
        lastFetchedAt={null}
        onRefresh={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  // 注意: axe-core は DOM 属性の静的な a11y ルール違反 (aria-* 不整合、
  // コントラスト比等) を検出するのみで、実際の Tab キー順序・focus-visible
  // outline の CSS 描画は検証しない (jsdom はレイアウト/CSS 疑似クラスを
  // 評価しないため)。この部分は既知の未検証ギャップとして
  // docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md に明記する。
});

describe("DryRunPreview (AC-α7-10 responsive、静的クラス存在チェック)", () => {
  // 注意: jsdom はレイアウトエンジンを持たないため、375px/768px での実際の
  // 折り返し・グリッド列数変化そのものは検証できない (本質的にブラウザが必要)。
  // ここでは「意図した responsive breakpoint クラスが JSX 出力に含まれているか」
  // という弱い代替チェックのみを行う。既知の未検証ギャップとして design doc に明記。
  it("progress lane の metric grid に md:grid-cols-4 クラスが出力される", () => {
    const { container } = render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(container.querySelector(".md\\:grid-cols-4")).not.toBeNull();
  });

  it("completion lane の metric grid に md:grid-cols-3 クラスが出力される", () => {
    const { container } = render(
      <DryRunPreview
        lane="completion"
        result={makeCompletionResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(container.querySelector(".md\\:grid-cols-3")).not.toBeNull();
  });

  it("テナート別内訳テーブルは overflow-x-auto でラップされる (横崩れ防止)", () => {
    const { container } = render(
      <DryRunPreview
        lane="progress"
        result={makeProgressResult()}
        isLoading={false}
        error={null}
        lastFetchedAt={NOW}
        onRefresh={vi.fn()}
      />,
    );
    expect(container.querySelector(".overflow-x-auto table")).not.toBeNull();
  });
});
