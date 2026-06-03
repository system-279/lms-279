/**
 * TenantCcEditor / TenantCcForm (Phase 6 PR-F2) のテスト。
 *
 * Radix-ui Select の interaction が RTL で煩雑なため、本テストは TenantCcForm
 * (CC 編集本体) に集中する。TenantCcEditor (tenant 選択ラッパー) はロード/エラー/空の
 * 表示分岐のみ確認する。
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
  GetTenantNotificationCcResponse,
  SuperTenantListResponse,
} from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import {
  TenantCcEditor,
  TenantCcForm,
  validateClientCcEmail,
} from "../TenantCcEditor";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => {
  superFetchMock.mockReset();
});

const baseConfig: GetTenantNotificationCcResponse = {
  ownerEmail: "owner@example.com",
  notificationCcEmails: ["cc1@example.com", "cc2@example.com"],
  completionNotificationEnabled: true,
};

describe("validateClientCcEmail", () => {
  it("正常な email は ok=true", () => {
    expect(validateClientCcEmail("a@example.com")).toEqual({
      ok: true,
      value: "a@example.com",
    });
  });

  it("前後空白は trim される", () => {
    expect(validateClientCcEmail("  a@example.com  ")).toEqual({
      ok: true,
      value: "a@example.com",
    });
  });

  it("空文字 / 空白のみは empty", () => {
    expect(validateClientCcEmail("")).toEqual({ ok: false, reason: "empty" });
    expect(validateClientCcEmail("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("内部 CRLF を含むと crlf (末尾は trim() で消えるので OK 扱い、BE 仕様と一致)", () => {
    expect(validateClientCcEmail("a@e.com\nfoo")).toEqual({
      ok: false,
      reason: "crlf",
    });
    expect(validateClientCcEmail("a@e.com\rfoo")).toEqual({
      ok: false,
      reason: "crlf",
    });
    // 末尾 \n は trim で消える → 通過 (BE validateSingleEmail と同じ挙動)
    expect(validateClientCcEmail("a@e.com\n")).toEqual({
      ok: true,
      value: "a@e.com",
    });
  });

  it("カンマを含むと comma", () => {
    expect(validateClientCcEmail("a@e.com,b@e.com")).toEqual({
      ok: false,
      reason: "comma",
    });
  });

  it("制御文字を含むと control", () => {
    expect(validateClientCcEmail("a@e.com\x07")).toEqual({
      ok: false,
      reason: "control",
    });
    expect(validateClientCcEmail("a@e.com\x7f")).toEqual({
      ok: false,
      reason: "control",
    });
  });

  it("形式違反は format", () => {
    expect(validateClientCcEmail("plain")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateClientCcEmail("a@b")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateClientCcEmail("@example.com")).toEqual({
      ok: false,
      reason: "format",
    });
  });
});

describe("TenantCcForm", () => {
  const renderForm = (tenantId = "t1") =>
    render(<TenantCcForm tenantId={tenantId} superFetch={superFetchMock} />);

  it("初期 GET で chips を表示する", async () => {
    superFetchMock.mockResolvedValueOnce(baseConfig);
    renderForm();
    expect(await screen.findByText("cc1@example.com")).toBeInTheDocument();
    expect(screen.getByText("cc2@example.com")).toBeInTheDocument();
    expect(screen.getByText(/テナント代表メール:/)).toHaveTextContent(
      "owner@example.com",
    );
    expect(screen.getByText("追加 CC (2 / 10)")).toBeInTheDocument();
  });

  it("初期 GET 失敗時はエラー + 再読み込みボタン", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "ロード失敗"),
    );
    renderForm();
    expect(await screen.findByText("ロード失敗")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "再読み込み" }),
    ).toBeInTheDocument();
  });

  it("追加ボタンで新しい chip を追加する", async () => {
    superFetchMock.mockResolvedValueOnce({
      ...baseConfig,
      notificationCcEmails: [],
    });
    renderForm();
    await screen.findByText("追加 CC (0 / 10)");

    fireEvent.change(screen.getByLabelText("追加する CC メール"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByText("追加 CC (1 / 10)")).toBeInTheDocument();
  });

  it("Enter キーでも追加できる", async () => {
    superFetchMock.mockResolvedValueOnce({
      ...baseConfig,
      notificationCcEmails: [],
    });
    renderForm();
    await screen.findByText("追加 CC (0 / 10)");

    const input = screen.getByLabelText(
      "追加する CC メール",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
  });

  // CRLF / 制御文字 / カンマの拒否は validateClientCcEmail の単体テストで網羅済み
  // (jsdom の input 経由では改行や制御文字が strip されることがあり component test では再現困難)。
  // 「無効入力時に既存 chips が壊れない」挙動は format / 重複 ケースで代表する。

  it("無効入力 (format) でエラー、既存 chips が壊れない", async () => {
    superFetchMock.mockResolvedValueOnce(baseConfig);
    renderForm();
    await screen.findByText("cc1@example.com");

    fireEvent.change(screen.getByLabelText("追加する CC メール"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(
      await screen.findByText("メールアドレスの形式が正しくありません。"),
    ).toBeInTheDocument();
    expect(screen.getByText("cc1@example.com")).toBeInTheDocument();
  });

  it("case-insensitive 重複はエラーで弾く", async () => {
    superFetchMock.mockResolvedValueOnce(baseConfig);
    renderForm();
    await screen.findByText("cc1@example.com");

    fireEvent.change(screen.getByLabelText("追加する CC メール"), {
      target: { value: "CC1@Example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(
      await screen.findByText("このメールアドレスはすでに登録されています。"),
    ).toBeInTheDocument();
    expect(screen.getByText("追加 CC (2 / 10)")).toBeInTheDocument();
  });

  it("上限 10 件に達したら追加 input が disable", async () => {
    const tenEmails = Array.from(
      { length: 10 },
      (_, i) => `cc${i}@example.com`,
    );
    superFetchMock.mockResolvedValueOnce({
      ...baseConfig,
      notificationCcEmails: tenEmails,
    });
    renderForm();
    await screen.findByText("追加 CC (10 / 10)");

    expect(screen.getByLabelText("追加する CC メール")).toBeDisabled();
    expect(screen.getByRole("button", { name: "追加" })).toBeDisabled();
  });

  it("削除後に同じ email を再追加できる", async () => {
    superFetchMock.mockResolvedValueOnce({
      ...baseConfig,
      notificationCcEmails: ["cc1@example.com"],
    });
    renderForm();
    await screen.findByText("cc1@example.com");

    // 削除
    fireEvent.click(
      screen.getByRole("button", { name: "cc1@example.com を削除" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("cc1@example.com")).not.toBeInTheDocument(),
    );

    // 同じ email を再追加
    fireEvent.change(screen.getByLabelText("追加する CC メール"), {
      target: { value: "cc1@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(await screen.findByText("cc1@example.com")).toBeInTheDocument();
  });

  it("差分が無いと保存ボタンは disable、差分があると enable", async () => {
    superFetchMock.mockResolvedValueOnce(baseConfig);
    renderForm();
    await screen.findByText("cc1@example.com");

    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    // 1 件削除で dirty
    fireEvent.click(
      screen.getByRole("button", { name: "cc2@example.com を削除" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
  });

  it("保存で PUT を呼び成功メッセージを出す", async () => {
    superFetchMock
      .mockResolvedValueOnce(baseConfig) // GET
      .mockResolvedValueOnce({
        ...baseConfig,
        notificationCcEmails: ["cc1@example.com"],
      }); // PUT
    renderForm();
    await screen.findByText("cc2@example.com");

    // 1 件削除して保存
    fireEvent.click(
      screen.getByRole("button", { name: "cc2@example.com を削除" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/tenants/t1/notification-cc-emails",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const putCall = superFetchMock.mock.calls.find(
      (c) => c[1]?.method === "PUT",
    );
    // Phase 3 PR 3d: progressReportEnabled は always-send-all で常に送信
    expect(JSON.parse(putCall![1].body)).toEqual({
      notificationCcEmails: ["cc1@example.com"],
      completionNotificationEnabled: true,
      progressReportEnabled: false,
    });
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    // 保存後は差分なし → 保存ボタン disable
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  // ============================================================
  // Phase 3 PR 3d (ADR-039 D-6): progressReportEnabled テナント opt-in
  // ============================================================

  it("progressReportEnabled トグルが表示され、既存値を反映する", async () => {
    superFetchMock.mockResolvedValueOnce({
      ...baseConfig,
      progressReportEnabled: true,
    });
    renderForm();
    await screen.findByText("cc1@example.com");
    expect(
      screen.getByRole("switch", {
        name: "このテナントへの進捗レポート定期配信を有効化",
      }),
    ).toBeChecked();
    expect(
      screen.getByText("このテナントへの進捗レポート定期配信 ON"),
    ).toBeInTheDocument();
  });

  it("旧テナント (progressReportEnabled 欠落) は default OFF を表示する", async () => {
    superFetchMock.mockResolvedValueOnce(baseConfig); // progressReportEnabled なし
    renderForm();
    await screen.findByText("cc1@example.com");
    expect(
      screen.getByRole("switch", {
        name: "このテナントへの進捗レポート定期配信を有効化",
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText("このテナントへの進捗レポート定期配信 OFF"),
    ).toBeInTheDocument();
  });

  it("progressReportEnabled のみ変更でも dirty 扱いとなり保存ボタン enable", async () => {
    superFetchMock.mockResolvedValueOnce(baseConfig);
    renderForm();
    await screen.findByText("cc1@example.com");

    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    // 進捗レポート OFF → ON に切替で dirty
    fireEvent.click(
      screen.getByRole("switch", {
        name: "このテナントへの進捗レポート定期配信を有効化",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
  });

  it("保存時に progressReportEnabled を含めて PUT する (always-send-all)", async () => {
    superFetchMock
      .mockResolvedValueOnce(baseConfig) // GET
      .mockResolvedValueOnce({
        ...baseConfig,
        progressReportEnabled: true,
      }); // PUT
    renderForm();
    await screen.findByText("cc1@example.com");

    // 進捗レポート ON に切替
    fireEvent.click(
      screen.getByRole("switch", {
        name: "このテナントへの進捗レポート定期配信を有効化",
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/tenants/t1/notification-cc-emails",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const putCall = superFetchMock.mock.calls.find(
      (c) => c[1]?.method === "PUT",
    );
    const sentBody = JSON.parse(putCall![1].body);
    expect(sentBody.progressReportEnabled).toBe(true);
    // 既存の CC / 完了通知の field も常に送信されている (always-send-all)
    expect(sentBody.completionNotificationEnabled).toBe(true);
    expect(sentBody.notificationCcEmails).toEqual([
      "cc1@example.com",
      "cc2@example.com",
    ]);
  });

  it("保存失敗時はエラー表示し chips state は維持", async () => {
    superFetchMock
      .mockResolvedValueOnce(baseConfig) // GET
      .mockRejectedValueOnce(new ApiError(400, "bad_request", "保存失敗")); // PUT
    renderForm();
    await screen.findByText("cc1@example.com");

    fireEvent.click(
      screen.getByRole("button", { name: "cc2@example.com を削除" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    expect(await screen.findByText("保存失敗")).toBeInTheDocument();
    // chips state は維持 (削除した cc2 はまだ表示されない)
    expect(screen.queryByText("cc2@example.com")).not.toBeInTheDocument();
    expect(screen.getByText("cc1@example.com")).toBeInTheDocument();
  });
});

describe("TenantCcEditor (tenant 選択ラッパー)", () => {
  const tenantsResponse: SuperTenantListResponse = {
    tenants: [
      {
        id: "demo",
        name: "デモテナント",
        ownerEmail: "owner@demo.com",
        status: "active",
        userCount: 3,
        gcipTenantId: null,
        useGcip: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
  };

  it("テナント一覧ロード成功で Select を表示する", async () => {
    superFetchMock.mockResolvedValueOnce(tenantsResponse);
    render(<TenantCcEditor />);
    expect(await screen.findByLabelText("対象テナント")).toBeInTheDocument();
  });

  it("テナント一覧 0 件時は案内文を表示する", async () => {
    superFetchMock.mockResolvedValueOnce({
      tenants: [],
      pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
    } satisfies SuperTenantListResponse);
    render(<TenantCcEditor />);
    expect(
      await screen.findByText("テナントが存在しません。"),
    ).toBeInTheDocument();
  });

  it("テナント一覧ロード失敗時はエラー + 再読み込み", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "tenants エラー"),
    );
    render(<TenantCcEditor />);
    expect(await screen.findByText("tenants エラー")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "再読み込み" }),
    ).toBeInTheDocument();
  });
});

// テストカバレッジ範囲外 (Radix Select の interaction は RTL で煩雑):
// - Select で tenant を切り替えると TenantCcForm が再 mount される動線。
//   key={selectedTenantId} を渡しているので React 側で確実に remount され、新 tenantId で
//   loadConfig が走る。挙動は本テストの「初期 GET で chips を表示する」が tenantId="t1" 固定で
//   保証している。
//   Radix Select の click flow は実機 (Phase 8 cutover の dev/staging 目視確認) でカバー。
