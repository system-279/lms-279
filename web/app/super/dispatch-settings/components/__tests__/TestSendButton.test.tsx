/**
 * TestSendButton (Phase 6 PR-F1) のテスト。
 * - 送信で POST /dispatch/test-send、成功表示 / エラー (rate_limit 等)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { TestSendResponse } from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import { TestSendButton } from "../TestSendButton";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => superFetchMock.mockReset());

describe("TestSendButton", () => {
  it("成功時に sentTo / messageId を表示", async () => {
    superFetchMock.mockResolvedValueOnce({
      messageId: "msg-001",
      sentTo: "admin@example.com",
      sentAt: "2026-05-22T01:00:00.000Z",
    } satisfies TestSendResponse);
    render(<TestSendButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "テスト送信" }));
    });
    expect(
      await screen.findByText(/admin@example.com に送信しました/),
    ).toBeInTheDocument();
    expect(screen.getByText(/msg-001/)).toBeInTheDocument();
  });

  it("レート制限エラーを表示", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(429, "rate_limit_exceeded", "テスト送信の 1 日あたり上限に達しました。"),
    );
    render(<TestSendButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "テスト送信" }));
    });
    expect(
      await screen.findByText("テスト送信の 1 日あたり上限に達しました。"),
    ).toBeInTheDocument();
  });
});
