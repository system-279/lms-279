import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PauseTimeoutOverlay } from "../PauseTimeoutOverlay";

describe("PauseTimeoutOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render when isPaused=false", () => {
    const { container } = render(
      <PauseTimeoutOverlay isPaused={false} onTimeout={vi.fn()} />
    );

    expect(container.firstElementChild).toBeNull();
  });

  it("renders countdown when isPaused=true", () => {
    render(
      <PauseTimeoutOverlay
        isPaused={true}
        timeoutSeconds={60}
        onTimeout={vi.fn()}
      />
    );

    expect(screen.getByText(/一時停止中/)).toBeInTheDocument();
    expect(screen.getByText(/01:00/)).toBeInTheDocument();
  });

  it("counts down each second", () => {
    render(
      <PauseTimeoutOverlay
        isPaused={true}
        timeoutSeconds={10}
        onTimeout={vi.fn()}
      />
    );

    expect(screen.getByText(/00:10/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText(/00:07/)).toBeInTheDocument();
  });

  it("resets countdown when isPaused changes false->true", () => {
    const { rerender } = render(
      <PauseTimeoutOverlay
        isPaused={true}
        timeoutSeconds={60}
        onTimeout={vi.fn()}
      />
    );

    // Count down 30 seconds
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByText(/00:30/)).toBeInTheDocument();

    // Unpause
    rerender(
      <PauseTimeoutOverlay
        isPaused={false}
        timeoutSeconds={60}
        onTimeout={vi.fn()}
      />
    );

    // Pause again - should reset to full timeout
    rerender(
      <PauseTimeoutOverlay
        isPaused={true}
        timeoutSeconds={60}
        onTimeout={vi.fn()}
      />
    );

    expect(screen.getByText(/01:00/)).toBeInTheDocument();
  });

  it("calls onTimeout when countdown reaches 0", () => {
    const onTimeout = vi.fn();

    render(
      <PauseTimeoutOverlay
        isPaused={true}
        timeoutSeconds={5}
        onTimeout={onTimeout}
      />
    );

    expect(onTimeout).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("uses default timeoutSeconds of 900 (15min)", () => {
    render(<PauseTimeoutOverlay isPaused={true} onTimeout={vi.fn()} />);

    // 900 seconds = 15:00
    expect(screen.getByText(/15:00/)).toBeInTheDocument();
  });
});
