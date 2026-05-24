/**
 * RunHistoryTable (Phase 6 PR-F2) のテスト。
 * - 初回ロード → table + status badge
 * - cursor 次ページ append
 * - 空状態 / エラー
 * - state race
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
} from "@testing-library/react";
import type {
  DispatchRun,
  GetRunsResponse,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { RunHistoryTable } from "../RunHistoryTable";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => {
  superFetchMock.mockReset();
});

function mkRun(runId: string, overrides: Partial<DispatchRun> = {}): DispatchRun {
  return {
    runId,
    triggeredAt: "2026-05-22T01:00:00.000Z",
    status: "completed",
    leaseExpiresAt: "2026-05-22T01:05:00.000Z",
    processedTenants: 2,
    sent: 3,
    skipped: 1,
    failed: 0,
    manualReviewRequired: 0,
    abortedReason: null,
    ttlExpireAt: "2027-05-22T01:00:00.000Z",
    ...overrides,
  };
}

describe("RunHistoryTable", () => {
  it("初回 GET で run 履歴を表示する", async () => {
    superFetchMock.mockResolvedValueOnce({
      runs: [
        mkRun("run-1"),
        mkRun("run-2", { status: "aborted", abortedReason: "scope_revoked" }),
      ],
      nextCursor: null,
    } satisfies GetRunsResponse);
    render(<RunHistoryTable />);
    expect(await screen.findByText("run-1")).toBeInTheDocument();
    expect(screen.getByText("run-2")).toBeInTheDocument();
    // status badge (日本語 label)
    expect(screen.getByText("正常終了")).toBeInTheDocument();
    expect(screen.getByText("中断")).toBeInTheDocument();
    // abortedReason
    expect(screen.getByText("scope_revoked")).toBeInTheDocument();
  });

  it("空応答時は「配信実行の履歴はまだありません」を表示", async () => {
    superFetchMock.mockResolvedValueOnce({
      runs: [],
      nextCursor: null,
    } satisfies GetRunsResponse);
    render(<RunHistoryTable />);
    expect(
      await screen.findByText("配信実行の履歴はまだありません"),
    ).toBeInTheDocument();
  });

  it("API エラー時はエラー + 再読み込みボタン (空表示は出さない)", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "runs 取得失敗"),
    );
    render(<RunHistoryTable />);
    expect(await screen.findByText("runs 取得失敗")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "再読み込み" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("配信実行の履歴はまだありません"),
    ).not.toBeInTheDocument();
  });

  it("nextCursor で「次の件を読み込む」append", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        runs: [mkRun("run-1")],
        nextCursor: "next-cursor",
      } satisfies GetRunsResponse)
      .mockResolvedValueOnce({
        runs: [mkRun("run-2", { status: "running" })],
        nextCursor: null,
      } satisfies GetRunsResponse);

    render(<RunHistoryTable />);
    await screen.findByText("run-1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "続きを読み込む" }));
    });

    expect(await screen.findByText("run-2")).toBeInTheDocument();
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(screen.getByText("実行中")).toBeInTheDocument();
    const lastUrl = superFetchMock.mock.calls.at(-1)![0] as string;
    expect(lastUrl).toContain("cursor=next-cursor");
  });

  it("再読み込みで初期化と同じ fetch を再実行", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "一時失敗"),
    );
    render(<RunHistoryTable />);
    await screen.findByText("一時失敗");

    superFetchMock.mockResolvedValueOnce({
      runs: [mkRun("run-1")],
      nextCursor: null,
    } satisfies GetRunsResponse);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    });

    expect(await screen.findByText("run-1")).toBeInTheDocument();
  });

  it("pending な loadMore fetch が後で解決されると累積 append される", async () => {
    // 初回 fetch
    superFetchMock.mockResolvedValueOnce({
      runs: [mkRun("init")],
      nextCursor: "cursor-pending",
    } satisfies GetRunsResponse);
    render(<RunHistoryTable />);
    await screen.findByText("init");

    // loadMore を slow pending にする
    let resolveSlow: (v: GetRunsResponse) => void = () => {};
    superFetchMock.mockImplementationOnce(
      () =>
        new Promise<GetRunsResponse>((r) => {
          resolveSlow = r;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "続きを読み込む" }));

    // 後着で解決 → 唯一の pending fetch なので requestId 一致で append される
    await act(async () => {
      resolveSlow({
        runs: [mkRun("later", { status: "running" })],
        nextCursor: null,
      });
    });

    expect(await screen.findByText("later")).toBeInTheDocument();
    expect(screen.getByText("init")).toBeInTheDocument();

    // NOTE: RunHistoryTable は filter がなく、handleLoadMore も loading=true 中は no-op で
    // ガードされているため、AuditLogTable で発生し得る「連打による race」を component test で
    // 再現する手段がない。requestId ロジックの race 対策は AuditLogTable の state race テストで
    // 共通実装を代表してカバーする。
  });
});
