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

    // window.open は成功時に Window-like オブジェクト ({ closed: false }) を返す前提。
    // popup ブロック検出 (null / closed=true) と区別するため明示的に non-null を返す。
    const windowOpenSpy = vi.fn().mockReturnValue({ closed: false } as Window);
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

    // 成功時は fallback UI (Gmail を開くリンク) が出ないこと
    expect(screen.queryByRole("link", { name: /Gmail を開いてください/ })).toBeNull();
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

    const windowOpenSpy = vi.fn().mockReturnValue({ closed: false } as Window);
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

describe("I5: popup ブロック時の fallback UI", () => {
  it("window.open が null を返す → 「下書きは作成済み」+ Gmail を開くリンクが描画される", async () => {
    const draftUrl = "https://mail.google.com/mail/u/0/?ogbl#drafts/r-popup-null";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ draftId: "r-popup-null", draftUrl }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // popup ブロック相当: window.open が null を返す
    const windowOpenSpy = vi.fn().mockReturnValue(null);
    vi.stubGlobal("open", windowOpenSpy);

    render(<PrintPage />);

    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });
    fireEvent.click(draftButton);

    // 「下書きは作成済み」を含む文言と Gmail を開くリンクが出る
    const fallbackLink = await screen.findByRole("link", { name: /Gmail を開いてください/ });
    expect(fallbackLink.getAttribute("href")).toBe(draftUrl);
    expect(fallbackLink.getAttribute("target")).toBe("_blank");
    // rel: target=_blank なら noopener / noreferrer 必須
    const rel = fallbackLink.getAttribute("rel") ?? "";
    expect(rel).toMatch(/noopener/);
    expect(rel).toMatch(/noreferrer/);

    // 「ブロック」と断定する文言は使わない: noopener/noreferrer + COOP で参照切れになり、
    // 成功時でも null/closed=true が返るケースがあり「blocked」誤検知し得るため。
    expect(screen.queryByText(/ブロックされました/)).toBeNull();
    expect(screen.queryByText(/下書きは作成済み/)).not.toBeNull();
  });

  it("window.open が closed=true の Window を返す → fallback UI が描画される", async () => {
    const draftUrl = "https://mail.google.com/mail/u/0/?ogbl#drafts/r-closed-true";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ draftId: "r-closed-true", draftUrl }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const windowOpenSpy = vi.fn().mockReturnValue({ closed: true } as Window);
    vi.stubGlobal("open", windowOpenSpy);

    render(<PrintPage />);

    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });
    fireEvent.click(draftButton);

    const fallbackLink = await screen.findByRole("link", { name: /Gmail を開いてください/ });
    expect(fallbackLink.getAttribute("href")).toBe(draftUrl);
  });

  it("2 回目の handleCreateDraft 開始時、前回の fallback URL がクリアされる", async () => {
    const firstUrl = "https://mail.google.com/mail/u/0/?ogbl#drafts/r-first";
    const secondUrl = "https://mail.google.com/mail/u/0/?ogbl#drafts/r-second";

    // 1 回目: null 返却 → fallback 表示。2 回目: 成功 ({ closed: false }) → fallback 消える
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ draftId: "r-first", draftUrl: firstUrl }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ draftId: "r-second", draftUrl: secondUrl }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const windowOpenSpy = vi
      .fn()
      .mockReturnValueOnce(null) // 1 回目: ブロック相当
      .mockReturnValue({ closed: false } as Window); // 2 回目以降: 成功
    vi.stubGlobal("open", windowOpenSpy);

    render(<PrintPage />);

    const draftButton = await screen.findByRole("button", { name: /Gmail 下書き作成/ });

    // 1 回目: fallback 表示
    fireEvent.click(draftButton);
    const firstLink = await screen.findByRole("link", { name: /Gmail を開いてください/ });
    expect(firstLink.getAttribute("href")).toBe(firstUrl);

    // 2 回目: ボタンが enabled に戻るのを待ってから再押下
    await waitFor(() => expect(draftButton).not.toBeDisabled());
    fireEvent.click(draftButton);

    // 古い fallback link が消えて新規 API が呼ばれる
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /Gmail を開いてください/ })).toBeNull();
    });
  });
});
