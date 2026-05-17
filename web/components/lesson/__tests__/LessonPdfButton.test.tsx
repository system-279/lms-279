import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LessonPdfButton } from "../LessonPdfButton";

const RESOURCE = {
  pdfFileName: "介護記録の書き方.pdf",
  pdfSizeBytes: 5 * 1024 * 1024,
  pdfUpdatedAt: "2026-05-17T00:00:00.000Z",
};

describe("LessonPdfButton", () => {
  it("AC-12 未合格時: disabled + 説明テキスト表示", () => {
    render(
      <LessonPdfButton
        resource={RESOURCE}
        quizPassed={false}
        fetchDownloadUrl={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /講座資料 PDF をダウンロード/ });
    expect(button).toBeDisabled();
    expect(screen.getByText(/テスト合格後にダウンロード/)).toBeInTheDocument();
  });

  it("AC-13 受講期間切れ時: 何も表示しない", () => {
    const { container } = render(
      <LessonPdfButton
        resource={RESOURCE}
        quizPassed={true}
        videoAccessExpired={true}
        fetchDownloadUrl={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("PDF 未添付 (resource undefined): 何も表示しない", () => {
    const { container } = render(
      <LessonPdfButton
        resource={undefined}
        quizPassed={true}
        fetchDownloadUrl={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("AC-12 合格時: クリックで fetchDownloadUrl が呼ばれ window.open が発火", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const fetchMock = vi.fn().mockResolvedValue({
      url: "https://signed.example.com/foo",
      fileName: "x.pdf",
      expiresAt: "2026-05-17T13:15:00Z",
    });
    render(
      <LessonPdfButton resource={RESOURCE} quizPassed={true} fetchDownloadUrl={fetchMock} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /講座資料 PDF をダウンロード/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        "https://signed.example.com/foo",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    openSpy.mockRestore();
  });

  it("ダウンロード失敗時: エラーメッセージを表示する", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("一時的に取得できません"));
    render(
      <LessonPdfButton resource={RESOURCE} quizPassed={true} fetchDownloadUrl={fetchMock} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /講座資料 PDF をダウンロード/ }));
    await waitFor(() => {
      expect(screen.getByText(/一時的に取得できません/)).toBeInTheDocument();
    });
  });
});
