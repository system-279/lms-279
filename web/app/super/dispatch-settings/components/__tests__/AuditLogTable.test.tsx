/**
 * AuditLogTable (Phase 6 PR-F2) のテスト。
 * - 初回ロード成功 → table 表示
 * - 適用ボタンでフィルタ反映 + 結果配列リセット
 * - cursor 次ページ append
 * - state race (古いレスポンスを破棄、requestId 方式)
 * - 空状態 / API error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type {
  DispatchAuditLog,
  GetAuditLogsResponse,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { AuditLogTable } from "../AuditLogTable";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => {
  superFetchMock.mockReset();
});

function mkLog(
  auditId: string,
  overrides: Partial<DispatchAuditLog> = {},
): DispatchAuditLog {
  return {
    auditId,
    runId: "run-x",
    runStartedAt: "2026-05-22T01:00:00.000Z",
    eventType: "user_notified",
    tenantId: "t1",
    userId: "u1",
    errorCode: null,
    errorMessage: null,
    durationMs: 12,
    createdAt: "2026-05-22T01:00:00.000Z",
    ttlExpireAt: "2027-05-22T01:00:00.000Z",
    ...overrides,
  };
}

describe("AuditLogTable", () => {
  it("初回 GET で監査ログテーブルを表示する", async () => {
    superFetchMock.mockResolvedValueOnce({
      logs: [mkLog("a1"), mkLog("a2", { eventType: "run_started" })],
      nextCursor: null,
    } satisfies GetAuditLogsResponse);
    render(<AuditLogTable />);
    expect(await screen.findByText("送信成功")).toBeInTheDocument();
    expect(screen.getByText("配信開始")).toBeInTheDocument();
    expect(superFetchMock).toHaveBeenCalledWith(
      "/api/v2/super/dispatch/audit-logs",
    );
  });

  it("空応答時は「該当する記録はありません」を表示", async () => {
    superFetchMock.mockResolvedValueOnce({
      logs: [],
      nextCursor: null,
    } satisfies GetAuditLogsResponse);
    render(<AuditLogTable />);
    expect(
      await screen.findByText("該当する記録はありません"),
    ).toBeInTheDocument();
  });

  it("API エラー時はエラー + 再読み込みボタン (空表示は出さない)", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "監査取得失敗"),
    );
    render(<AuditLogTable />);
    expect(await screen.findByText("監査取得失敗")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "再読み込み" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("該当する記録はありません"),
    ).not.toBeInTheDocument();
  });

  it("適用ボタンで filter を URL クエリに反映し、結果配列をリセットする", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        logs: [mkLog("a1")],
        nextCursor: null,
      } satisfies GetAuditLogsResponse)
      .mockResolvedValueOnce({
        logs: [mkLog("a2", { eventType: "run_aborted" })],
        nextCursor: null,
      } satisfies GetAuditLogsResponse);

    render(<AuditLogTable />);
    await screen.findByText("送信成功");

    fireEvent.change(screen.getByLabelText("テナント ID"), {
      target: { value: "tenant-x" },
    });
    fireEvent.change(screen.getByLabelText("受講者 ID"), {
      target: { value: "user-y" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "絞り込む" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining("tenantId=tenant-x"),
      ),
    );
    const lastUrl = superFetchMock.mock.calls.at(-1)![0] as string;
    expect(lastUrl).toContain("userId=user-y");

    // 結果配列は 2 回目だけになる (1 回目の a1 は消える)
    expect(await screen.findByText("配信中断")).toBeInTheDocument();
    expect(screen.queryByText("送信成功")).not.toBeInTheDocument();
  });

  it("nextCursor があれば「次の件を読み込む」で append する", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        logs: [mkLog("a1")],
        nextCursor: "cursor-2",
      } satisfies GetAuditLogsResponse)
      .mockResolvedValueOnce({
        logs: [mkLog("a2", { eventType: "settings_updated" })],
        nextCursor: null,
      } satisfies GetAuditLogsResponse);

    render(<AuditLogTable />);
    await screen.findByText("送信成功");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "続きを読み込む" }));
    });

    // append で両方表示される
    expect(await screen.findByText("設定変更")).toBeInTheDocument();
    expect(screen.getByText("送信成功")).toBeInTheDocument();
    // 2 回目の URL には cursor=cursor-2 が含まれる
    const lastUrl = superFetchMock.mock.calls.at(-1)![0] as string;
    expect(lastUrl).toContain("cursor=cursor-2");
  });

  it("state race: 古い fetch のレスポンスが後着しても結果に反映されない", async () => {
    // 初回 fetch は即解決 (初期表示まで進める)
    superFetchMock.mockResolvedValueOnce({
      logs: [mkLog("init", { eventType: "user_notified" })],
      nextCursor: null,
    } satisfies GetAuditLogsResponse);
    render(<AuditLogTable />);
    await screen.findByText("送信成功");

    // 2 回目 fetch を pending にする (slow fetch を模す)
    let resolveSlow: (v: GetAuditLogsResponse) => void = () => {};
    const slowPromise = new Promise<GetAuditLogsResponse>((r) => {
      resolveSlow = r;
    });
    superFetchMock.mockImplementationOnce(() => slowPromise);
    fireEvent.click(screen.getByRole("button", { name: "絞り込む" }));

    // 3 回目 fetch を即解決 (連打 = ユーザーが filter を変えて再適用したシナリオ)
    superFetchMock.mockResolvedValueOnce({
      logs: [mkLog("newest", { eventType: "settings_updated" })],
      nextCursor: null,
    } satisfies GetAuditLogsResponse);
    fireEvent.click(screen.getByRole("button", { name: "絞り込む" }));

    // 3 回目の結果が最終的に表示される
    await screen.findByText("設定変更");

    // 2 回目 fetch (slow) を後着で解決 → 古い requestId なので結果は破棄される
    await act(async () => {
      resolveSlow({
        logs: [mkLog("stale", { eventType: "user_failed_permanent" })],
        nextCursor: null,
      });
    });

    expect(
      screen.queryByText("送信失敗（恒久）"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("設定変更")).toBeInTheDocument();
  });

  it("再読み込みボタンで activeFilter (最後に適用したもの) で再取得", async () => {
    // 1 回目: 初回 fetch エラー
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "失敗"),
    );
    render(<AuditLogTable />);
    expect(await screen.findByText("失敗")).toBeInTheDocument();

    // リトライ成功
    superFetchMock.mockResolvedValueOnce({
      logs: [mkLog("a1")],
      nextCursor: null,
    } satisfies GetAuditLogsResponse);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    });
    expect(await screen.findByText("送信成功")).toBeInTheDocument();
  });
});
