import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MasterLessonPdfUploader } from "../MasterLessonPdfUploader";
import { ApiError } from "@/lib/api";

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
  const sizeBytes = sizeMB * 1024 * 1024;
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

beforeEach(() => {
  superFetchMock.mockReset();
  uploadFileWithProgressMock.mockReset();
});

describe("MasterLessonPdfUploader - validation", () => {
  it("AC-2 50MB 超過ファイル選択 → エラー表示 + API 未呼出", async () => {
    const onUpdated = vi.fn();
    render(
      <MasterLessonPdfUploader lessonId="L1" resource={undefined} onUpdated={onUpdated} />,
    );
    const input = screen.getByLabelText(/PDF ファイル/) as HTMLInputElement;
    const overSizeFile = makePdfFile(51, "big.pdf");
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
    fireEvent.change(input, { target: { files: [makePdfFile(51)] } });
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
});
