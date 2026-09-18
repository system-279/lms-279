/**
 * DispatchHistoryPage (PR2a 送信実績一覧) のテスト。
 * AuditLogTable.test.tsx と同型のパターン (superFetch mock、requestId race 対策済み hook)。
 * - 初回ロード成功 → テーブル表示 (tenantName / userName / status ラベル)
 * - 絞り込み(lane/tenantId) → クエリ反映 + 結果配列リセット
 * - nextCursor → 「もっと読み込む」で append
 * - 空状態 / API error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { GetSendHistoryResponse, SendHistoryEntry } from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import DispatchHistoryPage from "../page";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => {
  superFetchMock.mockReset();
});

function mkEntry(
  docId: string,
  overrides: Partial<SendHistoryEntry> = {},
): SendHistoryEntry {
  return {
    lane: "completion",
    tenantId: "tenant-a",
    tenantName: "テナントA",
    userId: "user-1",
    userName: "受講者一郎",
    userEmail: "user1@example.com",
    status: "sent",
    processedAt: "2026-06-03T01:00:00.000Z",
    sentAt: "2026-06-03T01:00:05.000Z",
    docId,
    ...overrides,
  };
}

describe("DispatchHistoryPage", () => {
  it("初回 GET で送信実績テーブルを表示する", async () => {
    superFetchMock.mockResolvedValueOnce({
      items: [mkEntry("user-1")],
      nextCursor: null,
    } satisfies GetSendHistoryResponse);
    render(<DispatchHistoryPage />);
    expect(await screen.findByText("テナントA")).toBeInTheDocument();
    expect(screen.getByText("受講者一郎")).toBeInTheDocument();
    expect(screen.getByText("送信済み")).toBeInTheDocument();
    expect(superFetchMock).toHaveBeenCalledWith(
      "/api/v2/super/dispatch/send-history",
    );
  });

  it("空応答時は「該当する送信実績はありません」を表示", async () => {
    superFetchMock.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    } satisfies GetSendHistoryResponse);
    render(<DispatchHistoryPage />);
    expect(
      await screen.findByText("該当する送信実績はありません"),
    ).toBeInTheDocument();
  });

  it("API エラー時はエラー + 再読み込みボタン", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "送信実績取得失敗"),
    );
    render(<DispatchHistoryPage />);
    expect(await screen.findByText("送信実績取得失敗")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "再読み込み" }),
    ).toBeInTheDocument();
  });

  it("絞り込みボタンで tenantId をクエリに反映し、結果配列をリセットする", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        items: [mkEntry("user-1")],
        nextCursor: null,
      } satisfies GetSendHistoryResponse)
      .mockResolvedValueOnce({
        items: [mkEntry("user-2", { userName: "受講者二郎", tenantId: "tenant-x" })],
        nextCursor: null,
      } satisfies GetSendHistoryResponse);

    render(<DispatchHistoryPage />);
    await screen.findByText("受講者一郎");

    fireEvent.change(screen.getByLabelText("テナント ID"), {
      target: { value: "tenant-x" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "絞り込む" }));
    });

    expect(superFetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("tenantId=tenant-x"),
    );
    expect(await screen.findByText("受講者二郎")).toBeInTheDocument();
    expect(screen.queryByText("受講者一郎")).not.toBeInTheDocument();
  });

  it("nextCursor があれば「もっと読み込む」で append する", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        items: [mkEntry("user-1")],
        nextCursor: "cursor-2",
      } satisfies GetSendHistoryResponse)
      .mockResolvedValueOnce({
        items: [mkEntry("user-2", { userName: "受講者二郎" })],
        nextCursor: null,
      } satisfies GetSendHistoryResponse);

    render(<DispatchHistoryPage />);
    await screen.findByText("受講者一郎");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "もっと読み込む" }));
    });

    expect(await screen.findByText("受講者二郎")).toBeInTheDocument();
    expect(screen.getByText("受講者一郎")).toBeInTheDocument();
  });

  it("userName が null の場合は「(不明)」を表示する", async () => {
    superFetchMock.mockResolvedValueOnce({
      items: [mkEntry("user-1", { userName: null, userEmail: null })],
      nextCursor: null,
    } satisfies GetSendHistoryResponse);
    render(<DispatchHistoryPage />);
    expect(await screen.findByText("(不明)")).toBeInTheDocument();
  });
});
