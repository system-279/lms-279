import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CopyButton } from "../copy-button";

describe("CopyButton (Issue #458)", () => {
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

  it("初期状態は idle で「コピー」と表示", () => {
    render(<CopyButton text="https://example.com/atali82i/student" />);
    expect(screen.getByRole("button")).toHaveTextContent("コピー");
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
    expect(screen.getByRole("button")).toHaveTextContent("コピーしました");
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
    render(<CopyButton text="https://example.com/atali82i/student" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("button")).toHaveTextContent("コピーしました");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button")).toHaveTextContent(/^コピー$/);
  });

  it("失敗時: 「コピー失敗」ボタン + 「URL を選択して手動コピーしてください」alert が表示される", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    writeTextMock.mockRejectedValue(new Error("NotAllowedError"));
    render(<CopyButton text="https://example.com/atali82i/student" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("button")).toHaveTextContent("コピー失敗");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "URL を選択して手動コピーしてください",
    );
    expect(consoleError).toHaveBeenCalled();
  });

  it("失敗時: 4 秒後に idle 状態に復帰し alert も消える", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeTextMock.mockRejectedValue(new Error("NotAllowedError"));
    render(<CopyButton text="https://example.com/atali82i/student" />);
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
});
