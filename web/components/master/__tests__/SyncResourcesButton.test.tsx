import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SyncResourcesButton } from "../SyncResourcesButton";
import { ApiError } from "@/lib/api";

const superFetchMock = vi.fn();

vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

beforeEach(() => {
  superFetchMock.mockReset();
});

describe("SyncResourcesButton", () => {
  it("AC-14 通常成功: tenantsCount X / lessonsCount Y を反映文言表示", async () => {
    superFetchMock.mockResolvedValueOnce({
      tenantsCount: 3,
      lessonsCount: 10,
      removedCount: 0,
    });
    render(<SyncResourcesButton courseId="C1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /配信済みテナントに資料情報を反映/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
    await waitFor(() => expect(superFetchMock).toHaveBeenCalled());
    expect(
      await screen.findByText(/3 件のテナント.*10 件のレッスン資料を反映/),
    ).toBeInTheDocument();
  });

  it("AC-14 配信先 0 件 (tenantsCount=0): 「コースを配信しているテナントがありません」文言", async () => {
    superFetchMock.mockResolvedValueOnce({
      tenantsCount: 0,
      lessonsCount: 0,
      removedCount: 0,
    });
    render(<SyncResourcesButton courseId="C1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /配信済みテナントに資料情報を反映/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
    expect(
      await screen.findByText(/このコースを配信しているテナントがありません/),
    ).toBeInTheDocument();
  });

  it("AC-14 配信先あり・更新対象 0 件: 文法的に正しい文言を返す (Evaluator HIGH 修正検証)", async () => {
    superFetchMock.mockResolvedValueOnce({
      tenantsCount: 3,
      lessonsCount: 0,
      removedCount: 0,
    });
    render(<SyncResourcesButton courseId="C1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /配信済みテナントに資料情報を反映/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
    expect(
      await screen.findByText(/配信先の 3 件のテナントには、更新対象の資料がありませんでした/),
    ).toBeInTheDocument();
    // 文法バグ防止: "X テナントに対し、しました。" のような不正文字列が出ないこと
    expect(screen.queryByText(/に対し、しました/)).toBeNull();
  });

  it("AC-14 削除モード: removedCount > 0 で削除文言が含まれる", async () => {
    superFetchMock.mockResolvedValueOnce({
      tenantsCount: 2,
      lessonsCount: 0,
      removedCount: 5,
    });
    render(<SyncResourcesButton courseId="C1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /配信済みテナントに資料情報を反映/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
    expect(
      await screen.findByText(/2 件のテナント.*5 件のレッスン資料を削除/),
    ).toBeInTheDocument();
  });

  it("ApiError → エラー表示 (確認 dialog 内 role=alert)", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(404, "not_found", "コースが見つかりません"),
    );
    render(<SyncResourcesButton courseId="C1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /配信済みテナントに資料情報を反映/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "実行する" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/マスターコースが見つかりません/);
  });

  it("確認 dialog でキャンセル → API 未呼出", async () => {
    render(<SyncResourcesButton courseId="C1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /配信済みテナントに資料情報を反映/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "キャンセル" }),
    );
    expect(superFetchMock).not.toHaveBeenCalled();
  });
});
