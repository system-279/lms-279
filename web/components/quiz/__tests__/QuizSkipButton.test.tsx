import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuizSkipButton } from "../QuizSkipButton";

describe("QuizSkipButton", () => {
  it("skipAvailable=false: 何も表示しない", () => {
    const { container } = render(
      <QuizSkipButton skipAvailable={false} onSkip={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("skipAvailable=true: ボタンが表示される", () => {
    render(<QuizSkipButton skipAvailable={true} onSkip={vi.fn()} />);
    expect(screen.getByRole("button", { name: "テストをスキップする" })).toBeInTheDocument();
  });

  it("ボタン押下でダイアログの3点(取り消し不可/出席記録/PDF文言)が表示される", () => {
    render(<QuizSkipButton skipAvailable={true} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "テストをスキップする" }));

    expect(screen.getByText("取り消しできません")).toBeInTheDocument();
    expect(screen.getByText("出席記録に「テストスキップ」として残ります")).toBeInTheDocument();
    // PDF文言は確定的な可否断定をしない抽象表現であること(設計判断6改訂)
    expect(
      screen.getByText("資料PDFのダウンロード可否はテナントの資料ポリシーに従います")
    ).toBeInTheDocument();
    expect(screen.queryByText(/ダウンロードできます/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ダウンロードできません/)).not.toBeInTheDocument();
  });

  it("キャンセルでダイアログが閉じ、onSkipは呼ばれない", () => {
    const onSkip = vi.fn();
    render(<QuizSkipButton skipAvailable={true} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "テストをスキップする" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(onSkip).not.toHaveBeenCalled();
    expect(screen.queryByText("テストをスキップしますか？")).not.toBeInTheDocument();
  });

  it("スキップ実行でonSkipが呼ばれ、成功後にダイアログが閉じる", async () => {
    const onSkip = vi.fn().mockResolvedValue(undefined);
    render(<QuizSkipButton skipAvailable={true} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "テストをスキップする" }));
    fireEvent.click(screen.getByRole("button", { name: "スキップする" }));

    await waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText("テストをスキップしますか？")).not.toBeInTheDocument()
    );
  });

  it("スキップ失敗時: エラーメッセージを表示しダイアログは開いたまま", async () => {
    const onSkip = vi.fn().mockRejectedValue(new Error("一時的に失敗しました"));
    render(<QuizSkipButton skipAvailable={true} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "テストをスキップする" }));
    fireEvent.click(screen.getByRole("button", { name: "スキップする" }));

    await waitFor(() => {
      expect(screen.getByText("一時的に失敗しました")).toBeInTheDocument();
    });
    expect(screen.getByText("テストをスキップしますか？")).toBeInTheDocument();
  });
});
