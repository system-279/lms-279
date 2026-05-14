/**
 * print page (Phase 2 Gmail draft button) のコンポーネントテスト。
 *
 * AC カバレッジ:
 * - AC-3: ownerEmail 未設定 → 「Gmail 下書き作成」ボタン disabled
 * - AC-9: 下書き作成成功時に window.open が draftUrl で呼ばれる
 *
 * Phase 2 で追加したボタン挙動のみを検証する (PDF 生成は Phase 1 でカバー済)。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// vi.hoisted でモック関数を持ち上げ (vi.mock 内で参照可能にする)
const mocks = vi.hoisted(() => ({
  getIdTokenMock: vi.fn(),
  superFetchMock: vi.fn(),
  requestGmailComposeAccessTokenMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ tenantId: "tenant-1", userId: "user-1" }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdTokenMock }),
}));

vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: mocks.superFetchMock }),
}));

vi.mock("@/lib/api", () => ({ API_BASE: "" }));

vi.mock("@/lib/gmail-oauth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gmail-oauth")>("@/lib/gmail-oauth");
  return {
    ...actual,
    requestGmailComposeAccessToken: mocks.requestGmailComposeAccessTokenMock,
  };
});

import PrintPage from "../page";

const META_FIXTURE = {
  students: [
    { userId: "user-1", userName: "山田 太郎", userEmail: "yamada@example.com" },
  ],
  tenantName: "莞爾会 長遊園",
};

beforeEach(() => {
  vi.clearAllMocks();
  // ownerEmail 設定済みデフォルト
  mocks.getIdTokenMock.mockResolvedValue("id-token");
  mocks.superFetchMock
    .mockResolvedValueOnce({ tenant: { ownerEmail: "owner@example.com" } })
    .mockResolvedValueOnce(META_FIXTURE);
  mocks.requestGmailComposeAccessTokenMock.mockResolvedValue("ya29.test_access_token");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AC-3: ownerEmail 未設定でボタン disabled", () => {
  it("ownerEmail が null のとき 「Gmail 下書き作成」 ボタンが disabled", async () => {
    mocks.superFetchMock
      .mockReset()
      .mockResolvedValueOnce({ tenant: { ownerEmail: null } })
      .mockResolvedValueOnce(META_FIXTURE);

    render(<PrintPage />);

    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });
    expect(draftButton).toBeDisabled();
    expect(draftButton.getAttribute("title")).toContain("テナント管理者メールが未設定");
  });

  it("ownerEmail 設定済みのとき 「Gmail 下書き作成」 ボタンが enabled", async () => {
    render(<PrintPage />);
    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });
    expect(draftButton).not.toBeDisabled();
  });
});

describe("AC-9: 成功時 window.open で Gmail タブを開く", () => {
  it("ボタン押下 → access token 取得 → API 呼び出し → window.open で draftUrl を開く", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        draftId: "r-12345",
        draftUrl: "https://mail.google.com/mail/u/0/?ogbl#drafts/r-12345",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const windowOpenSpy = vi.fn();
    vi.stubGlobal("open", windowOpenSpy);

    render(<PrintPage />);

    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });
    fireEvent.click(draftButton);

    await waitFor(() => {
      expect(mocks.requestGmailComposeAccessTokenMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/super/tenants/tenant-1/users/user-1/progress-pdf-draft"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("ya29.test_access_token"),
        }),
      );
    });

    await waitFor(() => {
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://mail.google.com/mail/u/0/?ogbl#drafts/r-12345",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });
});

describe("AC-5: scope 不足エラーで再同意リトライ", () => {
  it("gmail_scope_required を受信 → requestGmailComposeAccessToken 再呼び出し → 成功で window.open", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: "gmail_scope_required", message: "scope insufficient" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          draftId: "r-retry",
          draftUrl: "https://mail.google.com/mail/u/0/?ogbl#drafts/r-retry",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const windowOpenSpy = vi.fn();
    vi.stubGlobal("open", windowOpenSpy);

    render(<PrintPage />);

    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });
    fireEvent.click(draftButton);

    await waitFor(() => {
      expect(mocks.requestGmailComposeAccessTokenMock).toHaveBeenCalledTimes(2); // 初回 + リトライ
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://mail.google.com/mail/u/0/?ogbl#drafts/r-retry",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });
});
