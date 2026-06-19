import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MasterLessonPdfUploader } from "../MasterLessonPdfUploader";
import { ApiError } from "@/lib/api";
import { UploadError } from "@/lib/upload";

const superFetchMock = vi.fn();

vi.mock("@/lib/super-api", () => ({
  useSuperAdminFetch: () => ({ superFetch: superFetchMock }),
}));

const uploadFileWithProgressMock = vi.fn();

vi.mock("@/lib/upload", async () => {
  const actual = await vi.importActual<typeof import("@/lib/upload")>(
    "@/lib/upload",
  );
  return {
    ...actual,
    uploadFileWithProgress: (...args: unknown[]) =>
      uploadFileWithProgressMock(...args),
  };
});

const RESOURCE = {
  pdfFileName: "old.pdf",
  pdfSizeBytes: 3 * 1024 * 1024,
  pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
};

function makePdfFile(sizeMB: number, name = "test.pdf", type = "application/pdf"): File {
  // 上限が 300 MB に拡張されたため、実バイト列は最小化して size プロパティだけ偽装する
  // (大きい Uint8Array を確保すると vitest 並列実行時にメモリ圧迫の恐れ)
  // defineProperty は writable:false 既定のため同インスタンスで size を再定義不可。
  // 毎回 new File を返す前提で使うこと。
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: sizeMB * 1024 * 1024 });
  return file;
}

beforeEach(() => {
  superFetchMock.mockReset();
  uploadFileWithProgressMock.mockReset();
});

describe("MasterLessonPdfUploader - validation", () => {
  it("AC-2 300MB 超過ファイル選択 → エラー表示 + API 未呼出", async () => {
    const onUpdated = vi.fn();
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={onUpdated} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    const overSizeFile = makePdfFile(301, "big.pdf");
    fireEvent.change(input, { target: { files: [overSizeFile] } });
    expect(
      await screen.findByText(/ファイルサイズが上限/),
    ).toBeInTheDocument();
    expect(superFetchMock).not.toHaveBeenCalled();
  });

  it("AC-3 非 PDF (image/jpeg) 選択 → エラー表示 + API 未呼出", async () => {
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    const jpgFile = new File(["x"], "test.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [jpgFile] } });
    expect(
      await screen.findByText(/PDF ファイルのみアップロード可能/),
    ).toBeInTheDocument();
    expect(superFetchMock).not.toHaveBeenCalled();
  });
});

describe("MasterLessonPdfUploader - upload flow", () => {
  it("AC-1 アップロード成功 → upload-url → PUT → confirm → onUpdated 呼出", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        uploadUrl: "https://gcs.example.com/put",
        gcsPath: "lessons/L1/x.pdf",
        expiresAt: "2026-05-17T15:00:00Z",
      })
      .mockResolvedValueOnce({ resource: RESOURCE });
    uploadFileWithProgressMock.mockResolvedValueOnce(undefined);
    const onUpdated = vi.fn();
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={onUpdated} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(5)] } });
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    await waitFor(() => expect(superFetchMock).toHaveBeenCalledTimes(2));
    expect(superFetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v2/super/master/lessons/L1/pdf-upload-url",
      expect.objectContaining({ method: "POST" }),
    );
    expect(superFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v2/super/master/lessons/L1/pdf",
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it("AC-7 confirm が ApiError(file_too_large) → エラー表示", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        uploadUrl: "https://gcs.example.com/put",
        gcsPath: "lessons/L1/x.pdf",
        expiresAt: "2026-05-17T15:00:00Z",
      })
      .mockRejectedValueOnce(
        new ApiError(400, "file_too_large", "size 上限超過"),
      );
    uploadFileWithProgressMock.mockResolvedValueOnce(undefined);
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(5)] } });
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    expect(
      await screen.findByText(/ファイルサイズが上限/),
    ).toBeInTheDocument();
  });

  it("AC-6 upload-url が ApiError(gcs_unavailable) → transient エラー表示", async () => {
    superFetchMock.mockRejectedValueOnce(
      new ApiError(503, "gcs_unavailable", "transient"),
    );
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(5)] } });
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    expect(
      await screen.findByText(/一時的に取得できません/),
    ).toBeInTheDocument();
  });

  it("AC-11 GCS PUT 失敗時: confirm は呼ばれず、再試行可能 (Evaluator 推奨)", async () => {
    superFetchMock.mockResolvedValueOnce({
      uploadUrl: "https://gcs.example.com/put",
      gcsPath: "lessons/L1/x.pdf",
      expiresAt: "2026-05-17T15:00:00Z",
    });
    uploadFileWithProgressMock.mockRejectedValueOnce(
      new UploadError("network error", "network"),
    );
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(5)] } });
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    await waitFor(() =>
      expect(screen.getByText(/ネットワークエラー/)).toBeInTheDocument(),
    );
    expect(superFetchMock).toHaveBeenCalledTimes(1);
    // 再選択 + 再アップロードが可能であることを確認
    expect(
      screen.getByLabelText(/PDF ファイル/) as HTMLInputElement,
    ).toBeInTheDocument();
  });

  it("AC-12 confirm が gcs_file_missing → 専用エラー表示", async () => {
    superFetchMock
      .mockResolvedValueOnce({
        uploadUrl: "https://gcs.example.com/put",
        gcsPath: "lessons/L1/x.pdf",
        expiresAt: "2026-05-17T15:00:00Z",
      })
      .mockRejectedValueOnce(
        new ApiError(500, "gcs_file_missing", "missing"),
      );
    uploadFileWithProgressMock.mockResolvedValueOnce(undefined);
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(5)] } });
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    expect(
      await screen.findByText(/アップロードが完了していません/),
    ).toBeInTheDocument();
  });
});

describe("MasterLessonPdfUploader - delete/error", () => {
  it("AC-9 resource undefined: 削除ボタン非表示", () => {
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "PDF を削除" })).toBeNull();
  });

  it("AC-4 削除フロー: ボタン → 確認 → DELETE → onUpdated 呼出", async () => {
    superFetchMock.mockResolvedValueOnce(undefined);
    const onUpdated = vi.fn();
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={RESOURCE} onUpdated={onUpdated} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "PDF を削除" }));
    fireEvent.click(await screen.findByRole("button", { name: "削除する" }));
    await waitFor(() => expect(superFetchMock).toHaveBeenCalledTimes(1));
    expect(superFetchMock).toHaveBeenCalledWith(
      "/api/v2/super/master/lessons/L1/pdf",
      expect.objectContaining({ method: "DELETE" }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });
});

describe("MasterLessonPdfUploader - a11y (AC-16)", () => {
  it("エラーは role=alert", async () => {
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(301)] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/ファイルサイズが上限/);
  });

  it("登録済み resource を表示", () => {
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={RESOURCE} onUpdated={vi.fn()} />,
    );
    expect(screen.getByText(/old\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/3\.0 MB/)).toBeInTheDocument();
  });

  it("AC-16 アップロード中 progressbar の ARIA 属性 (Evaluator 推奨)", async () => {
    // upload-url は never-resolve でアップロード中状態を保持
    superFetchMock.mockImplementationOnce(() => new Promise(() => {}));
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={vi.fn()} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdfFile(5)] } });
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    const progressbar = await screen.findByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "0");
    expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    expect(progressbar).toHaveAttribute("aria-valuemax", "100");
    expect(progressbar).toHaveAttribute("aria-label", "アップロード進捗");
  });
});
