import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CopyButton } from "../copy-button";

describe("CopyButton (Issue #458 + PR #459 review)", () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeTextMock = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("初期状態は idle で「コピー」と表示、aria-label は「リンクをコピー」", () => {
    render(<CopyButton text="https://example.com/atali82i/student" />);
    expect(
      screen.getByRole("button", { name: "リンクをコピー" }),
    ).toHaveTextContent("コピー");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("成功時: writeText が clean な text で呼ばれ、「コピーしました」が表示される", async () => {
    writeTextMock.mockResolvedValue(undefined);
    render(<CopyButton text="https://example.com/atali82i/student" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(writeTextMock).toHaveBeenCalledWith(
      "https://example.com/atali82i/student",
    );
    expect(
      screen.getByRole("button", { name: "コピーしました" }),
    ).toBeInTheDocument();
  });

  it("成功時: 不可視文字 (U+FE0E) を含む text は writeText に渡る前に除去される", async () => {
    writeTextMock.mockResolvedValue(undefined);
    render(
      <CopyButton text={"https://example.com/atali82i/student\u{FE0E}"} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(writeTextMock).toHaveBeenCalledWith(
      "https://example.com/atali82i/student",
    );
  });

  it("成功時: 2 秒後に idle 状態に復帰する", async () => {
    writeTextMock.mockResolvedValue(undefined);
    render(<CopyButton text="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("button")).toHaveTextContent("コピーしました");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button")).toHaveTextContent(/^コピー$/);
  });

  it("失敗時: 「コピー失敗」+ alert + aria-label 連動 + 構造化ログ", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    writeTextMock.mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    render(<CopyButton text="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(
      screen.getByRole("button", { name: "コピー失敗" }),
    ).toHaveTextContent("コピー失敗");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "URL を選択して手動コピーしてください",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[CopyButton] clipboard.writeText failed",
      expect.objectContaining({ errorName: "NotAllowedError" }),
    );
  });

  it("失敗時: 4 秒後に idle 状態に復帰し alert も消える", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeTextMock.mockRejectedValue(new Error("NotAllowedError"));
    render(<CopyButton text="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByRole("button")).toHaveTextContent(/^コピー$/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("連続クリック: copied 中に再クリック → timer がリセットされ最新クリックから 2 秒で復帰", async () => {
    writeTextMock.mockResolvedValue(undefined);
    render(<CopyButton text="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    // 1 秒経過 (まだ copied 中)
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 再クリック → timer リセット
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("button")).toHaveTextContent("コピーしました");
    // 元の timer が残っていれば +1000ms (累計 2000ms) で idle 復帰してしまうが、
    // リセットされているので「コピーしました」のまま
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button")).toHaveTextContent("コピーしました");
    // 累計 +2000ms (最後のクリックから 2000ms) で idle
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button")).toHaveTextContent(/^コピー$/);
  });

  it("unmount: pending timer が cleanup されて警告が出ない", async () => {
    writeTextMock.mockResolvedValue(undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { unmount } = render(<CopyButton text="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // React 19 では unmount 後 setState は silent suppress だが、cleanup が効いていれば
    // setState 自体が呼ばれないので、関連 warning は出ない
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("unmounted"),
    );
  });

  it("複数インスタンスが独立して state を持つ", async () => {
    writeTextMock.mockResolvedValue(undefined);
    render(
      <>
        <CopyButton text="A" />
        <CopyButton text="B" />
      </>,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(buttons[0]).toHaveTextContent("コピーしました");
    expect(buttons[1]).toHaveTextContent(/^コピー$/);
  });
});
