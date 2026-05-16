import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SessionRulesNotice,
  formatDurationHours,
} from "../SessionRulesNotice";

describe("formatDurationHours", () => {
  it("formats exact 2 hours as '2時間'", () => {
    expect(
      formatDurationHours("2026-05-16T10:00:00Z", "2026-05-16T12:00:00Z")
    ).toBe("2時間");
  });

  it("formats exact 3 hours as '3時間' (production setting)", () => {
    expect(
      formatDurationHours("2026-05-16T10:00:00Z", "2026-05-16T13:00:00Z")
    ).toBe("3時間");
  });

  it("formats 2.5 hours as '2.5時間'", () => {
    expect(
      formatDurationHours("2026-05-16T10:00:00Z", "2026-05-16T12:30:00Z")
    ).toBe("2.5時間");
  });

  it("rounds 2 hours + 1ms to '2.0時間' (toFixed(1) absorbs the drift)", () => {
    expect(
      formatDurationHours("2026-05-16T10:00:00.000Z", "2026-05-16T12:00:00.001Z")
    ).toBe("2.0時間");
  });

  it("returns fallback for zero duration", () => {
    expect(
      formatDurationHours("2026-05-16T10:00:00Z", "2026-05-16T10:00:00Z")
    ).toBe("定められた時間");
  });

  it("returns fallback for negative duration (deadline before entry)", () => {
    expect(
      formatDurationHours("2026-05-16T12:00:00Z", "2026-05-16T10:00:00Z")
    ).toBe("定められた時間");
  });

  it("returns fallback for invalid ISO strings (NaN guard)", () => {
    expect(formatDurationHours("invalid", "invalid")).toBe("定められた時間");
  });

  it("returns fallback for sub-1-hour duration (env misconfig guard)", () => {
    expect(
      formatDurationHours("2026-05-16T10:00:00Z", "2026-05-16T10:30:00Z")
    ).toBe("定められた時間");
  });

  it("accepts very long duration (24 hours)", () => {
    expect(
      formatDurationHours("2026-05-16T00:00:00Z", "2026-05-17T00:00:00Z")
    ).toBe("24時間");
  });
});

describe("SessionRulesNotice", () => {
  it("renders fallback label when session is null", () => {
    render(<SessionRulesNotice session={null} />);
    expect(
      screen.getByText(/入室から定められた時間以内にテストに合格/)
    ).toBeInTheDocument();
  });

  it("does NOT render deadline row when session is null", () => {
    render(<SessionRulesNotice session={null} />);
    expect(screen.queryByText(/⏰ 制限時間:/)).not.toBeInTheDocument();
  });

  it("renders '3時間' label when session has 3-hour deadline", () => {
    render(
      <SessionRulesNotice
        session={{
          entryAt: "2026-05-16T10:00:00Z",
          deadlineAt: "2026-05-16T13:00:00Z",
          remainingMs: 3 * 60 * 60 * 1000,
          status: "active",
        }}
      />
    );
    expect(
      screen.getByText(/入室から3時間以内にテストに合格/)
    ).toBeInTheDocument();
  });

  it("renders deadline row with HH:MM format when session is active", () => {
    render(
      <SessionRulesNotice
        session={{
          entryAt: "2026-05-16T10:00:00Z",
          deadlineAt: "2026-05-16T13:05:00Z",
          remainingMs: 0,
          status: "active",
        }}
      />
    );
    expect(screen.getByText(/⏰ 制限時間: \d{2}:\d{2} まで/)).toBeInTheDocument();
  });
});
