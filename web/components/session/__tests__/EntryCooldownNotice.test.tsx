import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, renderHook, act } from "@testing-library/react";
import {
  useEntryCooldown,
  EntryCooldownInline,
  EntryCooldownDialog,
} from "../EntryCooldownNotice";

// Mock Radix Dialog to render children directly in jsdom (no portal issues, matches ForceExitDialog.test.tsx)
vi.mock("@radix-ui/react-dialog", () => {
  return {
    Root: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open?: boolean;
    }) => (open ? <div data-testid="dialog-root">{children}</div> : null),
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Overlay: () => <div data-testid="dialog-overlay" />,
    Content: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dialog-content">{children}</div>
    ),
    Title: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => <h2 {...props}>{children}</h2>,
    Close: ({
      children,
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => <button>{children}</button>,
  };
});

describe("useEntryCooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts inactive when retryAfterMs is undefined", () => {
    const { result } = renderHook(() => useEntryCooldown(undefined));
    expect(result.current.active).toBe(false);
    expect(result.current.remainingSec).toBe(0);
  });

  it("starts inactive when retryAfterMs is 0", () => {
    const { result } = renderHook(() => useEntryCooldown(0));
    expect(result.current.active).toBe(false);
  });

  it("starts active with the initial remaining seconds", () => {
    const { result } = renderHook(() => useEntryCooldown(5000));
    expect(result.current.active).toBe(true);
    expect(result.current.remainingSec).toBe(5);
  });

  it("counts down every second", () => {
    const { result } = renderHook(() => useEntryCooldown(3000));
    expect(result.current.remainingSec).toBe(3);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.remainingSec).toBe(2);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.remainingSec).toBe(1);
  });

  it("becomes inactive once it reaches 0", () => {
    const { result } = renderHook(() => useEntryCooldown(2000));

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.remainingSec).toBe(0);
    expect(result.current.active).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // 0 到達後も負数にならない・再アクティブ化しない
    expect(result.current.remainingSec).toBe(0);
    expect(result.current.active).toBe(false);
  });
});

describe("EntryCooldownInline", () => {
  it("shows the remaining seconds in the message", () => {
    render(<EntryCooldownInline remainingSec={42} />);
    expect(screen.getByText(/あと42秒で開始できます/)).toBeInTheDocument();
    expect(screen.getByText(/学習データは失われていません/)).toBeInTheDocument();
  });
});

describe("EntryCooldownDialog", () => {
  it("does not render when open=false", () => {
    const { container } = render(<EntryCooldownDialog open={false} remainingSec={10} />);
    expect(container.querySelector("[data-testid='dialog-root']")).toBeNull();
  });

  it("shows the remaining seconds when open=true", () => {
    render(<EntryCooldownDialog open={true} remainingSec={10} />);
    expect(screen.getByText("少しお待ちください")).toBeInTheDocument();
    expect(screen.getByText(/あと10秒で開始できます/)).toBeInTheDocument();
  });
});
