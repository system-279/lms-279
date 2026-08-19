/**
 * TenantQuizPolicyEditor (Stage 2) のコンポーネントテスト。
 *
 * AC-4「管理画面で実際に切替・保存でき、リロード後も保持される」の代替検証:
 * /super/* は SuperAdminLayout の Firebase 実認証ゲートを経由するため、AUTH_MODE=dev の
 * ローカル dev サーバーでも Playwright での自動ウォークスルーは実施できない
 * （ゲートは isDemo（テナントコンテキスト限定）または AUTH_MODE=firebase の実ログインのみを見る。
 * codex plan review の AC-4 High 指摘を受け、component test で代替。実装計画
 * imperative-bubbling-dijkstra.md 参照）。TenantCcEditor.test.tsx と同型のパターンで
 * useSuperAdminFetch をモックし、認証層を経由せず本体ロジックのみ検証する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { TenantQuizPolicyResponse } from "@lms-279/shared-types";
import { TenantQuizPolicyEditor } from "../TenantQuizPolicyEditor";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => {
  superFetchMock.mockReset();
});

const offPolicy: TenantQuizPolicyResponse = {
  quizSkipEnabled: false,
  pdfDownloadAllowedForSkipped: false,
  updatedBy: null,
  updatedAt: null,
};

describe("TenantQuizPolicyEditor", () => {
  it("初期 GET で既定値（両方 OFF）を表示する", async () => {
    superFetchMock.mockResolvedValueOnce(offPolicy);
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    expect(await screen.findByText("テスト任意化 OFF")).toBeInTheDocument();
    expect(
      screen.getByText("スキップした受講者への資料PDFダウンロード 許可 OFF"),
    ).toBeInTheDocument();
  });

  it("master OFF のときサブ設定 Switch が disabled", async () => {
    superFetchMock.mockResolvedValueOnce(offPolicy);
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    await screen.findByText("テスト任意化 OFF");
    expect(
      screen.getByLabelText("スキップした受講者への資料PDFダウンロードを許可"),
    ).toBeDisabled();
  });

  it("master ON にするとサブ設定 Switch が有効化される", async () => {
    superFetchMock.mockResolvedValueOnce(offPolicy);
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    await screen.findByText("テスト任意化 OFF");
    fireEvent.click(screen.getByLabelText("このテナントのテスト任意化を有効化"));

    await waitFor(() =>
      expect(
        screen.getByLabelText("スキップした受講者への資料PDFダウンロードを許可"),
      ).toBeEnabled(),
    );
  });

  it("差分が無いと保存ボタンは disable、差分があると enable", async () => {
    superFetchMock.mockResolvedValueOnce(offPolicy);
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    await screen.findByText("テスト任意化 OFF");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText("このテナントのテスト任意化を有効化"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
  });

  it("両スイッチ ON にして保存すると PUT を呼び、保存後の値を反映する", async () => {
    superFetchMock
      .mockResolvedValueOnce(offPolicy) // GET
      .mockResolvedValueOnce({
        quizSkipEnabled: true,
        pdfDownloadAllowedForSkipped: true,
        updatedBy: "admin@example.com",
        updatedAt: "2026-08-19T00:00:00.000Z",
      }); // PUT
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    await screen.findByText("テスト任意化 OFF");
    fireEvent.click(screen.getByLabelText("このテナントのテスト任意化を有効化"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("スキップした受講者への資料PDFダウンロードを許可"),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByLabelText("スキップした受講者への資料PDFダウンロードを許可"),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/tenants/acme/quiz-policy",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const putCall = superFetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(JSON.parse(putCall![1].body)).toEqual({
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: true,
    });

    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    expect(screen.getByText("テスト任意化 ON")).toBeInTheDocument();
    expect(screen.getByText(/設定者:/)).toHaveTextContent("admin@example.com");
    // 保存後は差分なし → 保存ボタン disable
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("quizSkipEnabled=false かつ pdfDownloadAllowedForSkipped=true の組み合わせで保存できる（master OFF 時のサブ設定保持）", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        quizSkipEnabled: true,
        pdfDownloadAllowedForSkipped: true,
        updatedBy: "admin@example.com",
        updatedAt: "2026-08-19T00:00:00.000Z",
      }) // GET: 初期状態は両方 ON
      .mockResolvedValueOnce({
        quizSkipEnabled: false,
        pdfDownloadAllowedForSkipped: true,
        updatedBy: "admin@example.com",
        updatedAt: "2026-08-19T00:01:00.000Z",
      }); // PUT
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    await screen.findByText("テスト任意化 ON");
    // master のみ OFF に戻す（サブ設定は操作しない）
    fireEvent.click(screen.getByLabelText("このテナントのテスト任意化を有効化"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    const putCall = superFetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(JSON.parse(putCall![1].body)).toEqual({
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: true,
    });
    expect(
      await screen.findByText("スキップした受講者への資料PDFダウンロード 許可 ON"),
    ).toBeInTheDocument();
  });

  it("初期 GET 失敗時はエラー + 再読み込みボタン", async () => {
    superFetchMock.mockRejectedValueOnce(new Error("取得に失敗しました"));
    render(<TenantQuizPolicyEditor tenantId="acme" />);

    expect(await screen.findByText("取得に失敗しました")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });
});
