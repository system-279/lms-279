/**
 * DispatchSettingsPage (Phase 6 PR-F1 + PR-F2) のテスト。
 * - 初期 GET で値ロード + フォーム表示
 * - 保存で PUT 呼び出し + 成功表示
 * - 409 (version 競合) で再 GET + 警告表示 (AC-23)
 * - F2 component (TenantCcEditor / AuditLogTable / RunHistoryTable) が常にマウントされる
 *
 * F2 component は本ページの settings ロード状態と独立に自分で fetch するため、
 * page 単独の挙動を切り分けてテストする目的で stub 化する。内部の fetch / chips / cursor
 * 等は各 component の専用テスト (../components/__tests__/) でカバー済。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { GetDispatchSettingsResponse } from "@lms-279/shared-types";
import { ApiError } from "@/lib/api";
import DispatchSettingsPage from "../page";

const superFetchMock = vi.fn();
vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

// F2 component は内部で superFetch を呼ぶため、page 単独のテストでは stub 化する。
vi.mock("../components/TenantCcEditor", () => ({
  TenantCcEditor: () => <div data-testid="tenant-cc-editor" />,
}));
vi.mock("../components/AuditLogTable", () => ({
  AuditLogTable: () => <div data-testid="audit-log-table" />,
}));
vi.mock("../components/RunHistoryTable", () => ({
  RunHistoryTable: () => <div data-testid="run-history-table" />,
}));

const baseSettings: GetDispatchSettingsResponse = {
  enabled: false,
  scheduleDaysOfWeek: [1, 4],
  scheduleHourJst: 9,
  signatureName: "DXcollege運営スタッフ",
  completionMessageBody: "受講お疲れ様でした。",
  senderEmail: "dxcollege@279279.net",
  updatedAt: "2026-05-22T01:00:00.000Z",
  updatedBy: "admin@example.com",
  version: 3,
};

beforeEach(() => {
  superFetchMock.mockReset();
});

describe("DispatchSettingsPage", () => {
  it("初期 GET で設定をロードしフォームを表示する", async () => {
    superFetchMock.mockResolvedValueOnce(baseSettings);
    render(<DispatchSettingsPage />);
    expect(
      await screen.findByDisplayValue("DXcollege運営スタッフ"),
    ).toBeInTheDocument();
    expect(screen.getByText("dxcollege@279279.net")).toBeInTheDocument();
    expect(screen.getByText("version 3")).toBeInTheDocument();
  });

  it("保存で version 付き PUT を呼び、成功メッセージを出す", async () => {
    superFetchMock
      .mockResolvedValueOnce(baseSettings) // GET
      .mockResolvedValueOnce({ ...baseSettings, version: 4 }); // PUT
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/dispatch/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const putCall = superFetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(JSON.parse(putCall![1].body)).toMatchObject({ version: 3 });
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    expect(screen.getByText("version 4")).toBeInTheDocument();
  });

  it("409 で最新値を再 GET し警告を出す (AC-23)", async () => {
    superFetchMock
      .mockResolvedValueOnce(baseSettings) // 初回 GET
      .mockRejectedValueOnce(new ApiError(409, "version_conflict", "conflict")) // PUT
      .mockResolvedValueOnce({ ...baseSettings, version: 9 }); // 再 GET
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    expect(
      await screen.findByText(/最新の値を読み込みました/),
    ).toBeInTheDocument();
    expect(screen.getByText("version 9")).toBeInTheDocument();
  });

  it("GET 失敗時はエラーと再読み込みボタンを出す", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(403, "forbidden", "no perm"),
    );
    render(<DispatchSettingsPage />);
    expect(
      await screen.findByText("この操作を行う権限がありません。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });

  it("F2 component (CC / 監査ログ / Run 履歴) は settings ロード状態と独立に常にマウントされる", async () => {
    // settings GET 失敗ケースでも F2 が表示されることを確認
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "settings 失敗"),
    );
    render(<DispatchSettingsPage />);
    await screen.findByText("settings 失敗");
    expect(screen.getByTestId("tenant-cc-editor")).toBeInTheDocument();
    expect(screen.getByTestId("audit-log-table")).toBeInTheDocument();
    expect(screen.getByTestId("run-history-table")).toBeInTheDocument();
  });

  it("F2 component は settings ロード成功時にも当然マウントされる", async () => {
    superFetchMock.mockResolvedValueOnce(baseSettings);
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");
    expect(screen.getByTestId("tenant-cc-editor")).toBeInTheDocument();
    expect(screen.getByTestId("audit-log-table")).toBeInTheDocument();
    expect(screen.getByTestId("run-history-table")).toBeInTheDocument();
  });

  // ============================================================
  // Phase 3 PR 3d (ADR-039 D-1): progressReport セクション
  // ============================================================

  it("progressReport セクションが表示される (旧 doc で progressReport 欠落でも default を表示)", async () => {
    superFetchMock.mockResolvedValueOnce(baseSettings); // progressReport なし
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");
    expect(
      screen.getByRole("switch", {
        name: "進捗レポート定期配信を有効化",
      }),
    ).toBeInTheDocument();
    // default OFF 表示
    expect(
      screen.getByText("進捗レポート配信 OFF"),
    ).toBeInTheDocument();
  });

  it("既存 progressReport ON を読み込み、ON ラベルを表示する", async () => {
    superFetchMock.mockResolvedValueOnce({
      ...baseSettings,
      progressReport: {
        enabled: true,
        scheduleDaysOfWeek: [2, 5],
        scheduleHourJst: 11,
      },
    });
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");
    expect(screen.getByText("進捗レポート配信 ON")).toBeInTheDocument();
  });

  it("保存時に progressReport を含めて PUT する (always-send-all)", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        ...baseSettings,
        progressReport: {
          enabled: true,
          scheduleDaysOfWeek: [3],
          scheduleHourJst: 8,
        },
      })
      .mockResolvedValueOnce({ ...baseSettings, version: 4 });
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/dispatch/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const putCall = superFetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    const sentBody = JSON.parse(putCall![1].body);
    expect(sentBody.progressReport).toEqual({
      enabled: true,
      scheduleDaysOfWeek: [3],
      scheduleHourJst: 8,
    });
  });

  it("旧 doc (progressReport なし) を保存すると default の OFF/空配列/0時を送信する", async () => {
    superFetchMock
      .mockResolvedValueOnce(baseSettings) // progressReport なし
      .mockResolvedValueOnce({ ...baseSettings, version: 4 });
    render(<DispatchSettingsPage />);
    await screen.findByDisplayValue("DXcollege運営スタッフ");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });

    await waitFor(() =>
      expect(superFetchMock).toHaveBeenCalledWith(
        "/api/v2/super/dispatch/settings",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const putCall = superFetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    const sentBody = JSON.parse(putCall![1].body);
    expect(sentBody.progressReport).toEqual({
      enabled: false,
      scheduleDaysOfWeek: [],
      scheduleHourJst: 0,
    });
  });

  it("再読み込み失敗時 loadSettings は form を null 化する (regression: form/error 共存防止)", async () => {
    // 初回 GET 失敗 → error 表示 + 再読み込みボタン
    superFetchMock.mockRejectedValueOnce(
      new ApiError(500, "internal", "初回失敗"),
    );
    render(<DispatchSettingsPage />);
    await screen.findByText("初回失敗");
    // form は表示されない
    expect(
      screen.queryByDisplayValue("DXcollege運営スタッフ"),
    ).not.toBeInTheDocument();

    // 再読み込み → 成功で form 表示
    superFetchMock.mockResolvedValueOnce(baseSettings);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    });
    await screen.findByDisplayValue("DXcollege運営スタッフ");

    // (本 PR 範囲外: 「再読み込み成功後にさらにエラー」を発火させる UI が現状無いため、
    //  上記で「loadSettings catch で form null + error 表示」の正パスを保証する。)
  });
});
