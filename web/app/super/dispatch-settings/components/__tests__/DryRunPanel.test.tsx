/**
 * DryRunPanel (Phase 6 PR-F1) のテスト。
 * - 実行で POST /dispatch/dry-run、対象テーブル表示 / 0 件 / エラー
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { DryRunResponse } from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { DryRunPanel } from "../DryRunPanel";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => superFetchMock.mockReset());

describe("DryRunPanel", () => {
  it("対象がある場合テーブルに表示する", async () => {
    const res: DryRunResponse = {
      wouldNotify: [
        {
          tenantId: "t1",
          userId: "u1",
          userEmail: "u1@example.com",
          userName: "User 1",
          progressSnapshot: {
            completedLessons: 2,
            totalLessons: 2,
            coursesCompleted: 1,
            coursesTotal: 1,
          },
        },
      ],
      evaluatedAt: "2026-05-22T01:00:00.000Z",
    };
    superFetchMock.mockResolvedValueOnce(res);
    render(<DryRunPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ドライラン実行" }));
    });
    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/dispatch/dry-run",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("u1@example.com")).toBeInTheDocument();
    expect(screen.getByText("User 1")).toBeInTheDocument();
  });

  it("0 件の場合は対象なし表示", async () => {
    superFetchMock.mockResolvedValueOnce({
      wouldNotify: [],
      evaluatedAt: "2026-05-22T01:00:00.000Z",
    } satisfies DryRunResponse);
    render(<DryRunPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ドライラン実行" }));
    });
    expect(await screen.findByText("送信対象はありません")).toBeInTheDocument();
  });

  it("再実行が失敗したら前回の結果テーブルを消す", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        wouldNotify: [
          {
            tenantId: "t1",
            userId: "u1",
            userEmail: "u1@example.com",
            userName: "User 1",
            progressSnapshot: {
              completedLessons: 1,
              totalLessons: 1,
              coursesCompleted: 1,
              coursesTotal: 1,
            },
          },
        ],
        evaluatedAt: "2026-05-22T01:00:00.000Z",
      } satisfies DryRunResponse)
      .mockRejectedValueOnce(new ApiError(500, "internal", "再実行エラー"));
    render(<DryRunPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ドライラン実行" }));
    });
    expect(await screen.findByText("u1@example.com")).toBeInTheDocument();
    // 2 回目は失敗
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ドライラン実行" }));
    });
    expect(await screen.findByText("再実行エラー")).toBeInTheDocument();
    // 前回の対象テーブルは消えている
    expect(screen.queryByText("u1@example.com")).not.toBeInTheDocument();
  });

  it("エラー時はエラーメッセージ表示", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "サーバーエラー"),
    );
    render(<DryRunPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ドライラン実行" }));
    });
    expect(await screen.findByText("サーバーエラー")).toBeInTheDocument();
  });
});
