import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { SessionTimer } from "../SessionTimer";

describe("SessionTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders remaining time correctly", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    vi.setSystemTime(now);

    const deadline = "2026-03-24T11:30:00Z"; // 1h30m from now
    render(<SessionTimer deadlineAt={deadline} onExpired={vi.fn()} />);

    expect(screen.getByText(/残り 1:30:00/)).toBeInTheDocument();
  });

  it("shows default styling when >30min remaining", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    vi.setSystemTime(now);

    const deadline = "2026-03-24T11:00:00Z"; // 60min
    const { container } = render(
      <SessionTimer deadlineAt={deadline} onExpired={vi.fn()} />
    );

    const timerDiv = container.firstElementChild!;
    expect(timerDiv.className).toContain("bg-muted");
    expect(timerDiv.className).not.toContain("bg-amber");
    expect(timerDiv.className).not.toContain("bg-red");
  });

  it("shows amber styling when 10-30min remaining", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    vi.setSystemTime(now);

    const deadline = "2026-03-24T10:20:00Z"; // 20min
    const { container } = render(
      <SessionTimer deadlineAt={deadline} onExpired={vi.fn()} />
    );

    const timerDiv = container.firstElementChild!;
    expect(timerDiv.className).toContain("bg-amber-100");
    expect(timerDiv.className).toContain("border-amber-300");
    expect(timerDiv.className).toContain("text-amber-900");
  });

  it("shows red styling when <10min remaining", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    vi.setSystemTime(now);

    const deadline = "2026-03-24T10:05:00Z"; // 5min
    const { container } = render(
      <SessionTimer deadlineAt={deadline} onExpired={vi.fn()} />
    );

    const timerDiv = container.firstElementChild!;
    expect(timerDiv.className).toContain("bg-red-100");
    expect(timerDiv.className).toContain("border-red-300");
    expect(timerDiv.className).toContain("text-red-900");
    expect(timerDiv.className).toContain("animate-pulse");
  });

  it("calls onExpired when timer reaches 0", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    vi.setSystemTime(now);

    const onExpired = vi.fn();
    const deadline = "2026-03-24T10:00:03Z"; // 3 seconds from now

    render(<SessionTimer deadlineAt={deadline} onExpired={onExpired} />);

    expect(onExpired).not.toHaveBeenCalled();

    // Advance 3 seconds to reach deadline
    act(() => {
      vi.setSystemTime(new Date("2026-03-24T10:00:03Z"));
      vi.advanceTimersByTime(3000);
    });

    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("does not call onExpired multiple times", () => {
    const now = new Date("2026-03-24T10:00:00Z");
    vi.setSystemTime(now);

    const onExpired = vi.fn();
    const deadline = "2026-03-24T10:00:02Z"; // 2 seconds

    render(<SessionTimer deadlineAt={deadline} onExpired={onExpired} />);

    act(() => {
      vi.setSystemTime(new Date("2026-03-24T10:00:05Z"));
      vi.advanceTimersByTime(5000);
    });

    // Should only fire once despite multiple ticks past deadline
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
