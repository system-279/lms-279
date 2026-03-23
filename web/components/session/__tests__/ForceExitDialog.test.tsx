import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForceExitDialog } from "../ForceExitDialog";

// Mock Radix Dialog to render children directly in jsdom (no portal issues)
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

describe("ForceExitDialog", () => {
  it("does not render when open=false", () => {
    const { container } = render(
      <ForceExitDialog open={false} reason="pause_timeout" />
    );

    expect(
      screen.queryByText("強制退室")
    ).not.toBeInTheDocument();
    expect(container.querySelector("[data-testid='dialog-root']")).toBeNull();
  });

  it("shows pause_timeout message when reason='pause_timeout'", () => {
    render(<ForceExitDialog open={true} reason="pause_timeout" />);

    expect(screen.getByText("強制退室")).toBeInTheDocument();
    expect(
      screen.getByText(
        "15分以上一時停止したため、強制退室となりました。"
      )
    ).toBeInTheDocument();
  });

  it("shows time_limit message when reason='time_limit'", () => {
    render(<ForceExitDialog open={true} reason="time_limit" />);

    expect(screen.getByText("強制退室")).toBeInTheDocument();
    expect(
      screen.getByText(
        "入室から2時間が経過したため、強制退室となりました。"
      )
    ).toBeInTheDocument();
  });

  it("renders re-enter button when open", () => {
    render(<ForceExitDialog open={true} reason="time_limit" />);

    expect(screen.getByText("再入室する")).toBeInTheDocument();
  });
});
