import { describe, it, expect } from "vitest";
import { detectSessionAnomalies, type AnomalyCandidate } from "../session-anomaly.js";

const NOW = new Date("2026-08-20T10:00:00.000Z");

function candidate(overrides: Partial<AnomalyCandidate> & { sessionId: string }): AnomalyCandidate {
  return {
    sessionId: overrides.sessionId,
    userId: overrides.userId ?? "user-1",
    status: overrides.status ?? "completed",
    entryAt: overrides.entryAt ?? null,
    exitAt: overrides.exitAt ?? null,
    isSynthetic: overrides.isSynthetic ?? false,
    deadlineAt: overrides.deadlineAt,
  };
}

describe("detectSessionAnomalies", () => {
  it("returns empty map for empty input", () => {
    const result = detectSessionAnomalies([], NOW);
    expect(result.size).toBe(0);
  });

  it("does not flag a single non-overlapping session", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "2026-08-20T09:00:00.000Z", exitAt: "2026-08-20T09:10:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("does not flag back-to-back sessions where entryAt === previous exitAt exactly (F1's territory)", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "2026-08-20T09:00:00.000Z", exitAt: "2026-08-20T09:10:00.000Z" }),
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:10:00.000Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("flags overlap_previous on the later session only, at the 1ms boundary", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "2026-08-20T09:00:00.000Z", exitAt: "2026-08-20T09:10:00.000Z" }),
      // 1ms before previous exitAt → overlap
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:09:59.999Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.get("s1")).toBeUndefined();
    expect(result.get("s2")).toEqual(["overlap_previous"]);
  });

  it("does not flag when gap is exactly 1ms (no overlap)", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "2026-08-20T09:00:00.000Z", exitAt: "2026-08-20T09:10:00.000Z" }),
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:10:00.001Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("flags negative_duration when exitAt < entryAt, and excludes it from the overlap sweep", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "2026-08-20T09:10:00.000Z", exitAt: "2026-08-20T09:00:00.000Z" }),
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:05:00.000Z", exitAt: "2026-08-20T09:15:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.get("s1")).toEqual(["negative_duration"]);
    expect(result.get("s2")).toBeUndefined();
  });

  it("flags stale_active when status=active and entryAt is older than SESSION_DURATION_MS", () => {
    const sessions = [
      // NOW - 3h, default SESSION_DURATION_MS is 2h
      candidate({ sessionId: "s1", status: "active", entryAt: "2026-08-20T07:00:00.000Z", exitAt: null }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.get("s1")).toEqual(["stale_active"]);
  });

  it("does not flag stale_active when entryAt is within SESSION_DURATION_MS", () => {
    const sessions = [
      candidate({ sessionId: "s1", status: "active", entryAt: "2026-08-20T09:00:00.000Z", exitAt: null }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("does not flag stale_active for non-active status even if very old", () => {
    const sessions = [
      candidate({ sessionId: "s1", status: "force_exited", entryAt: "2020-01-01T00:00:00.000Z", exitAt: null }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("excludes synthetic sessions from the overlap sweep", () => {
    const sessions = [
      candidate({
        sessionId: "s1",
        entryAt: "2026-08-20T09:00:00.000Z",
        exitAt: "2026-08-20T09:10:00.000Z",
        isSynthetic: true,
      }),
      // would overlap s1 if s1 weren't synthetic
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:05:00.000Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("silently excludes unparseable dates from overlap detection", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "not-a-date", exitAt: "2026-08-20T09:10:00.000Z" }),
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:05:00.000Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("keeps user groups separate (no cross-user overlap detection)", () => {
    const sessions = [
      candidate({ sessionId: "s1", userId: "user-a", entryAt: "2026-08-20T09:00:00.000Z", exitAt: "2026-08-20T09:10:00.000Z" }),
      candidate({ sessionId: "s2", userId: "user-b", entryAt: "2026-08-20T09:05:00.000Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("a long session engulfing multiple later sessions flags every engulfed session, not just the first", () => {
    const sessions = [
      candidate({ sessionId: "s1", entryAt: "2026-08-20T09:00:00.000Z", exitAt: "2026-08-20T10:00:00.000Z" }),
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:10:00.000Z", exitAt: "2026-08-20T09:20:00.000Z" }),
      candidate({ sessionId: "s3", entryAt: "2026-08-20T09:30:00.000Z", exitAt: "2026-08-20T09:40:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.get("s1")).toBeUndefined();
    expect(result.get("s2")).toEqual(["overlap_previous"]);
    expect(result.get("s3")).toEqual(["overlap_previous"]);
  });

  it("active sessions (exitAt=null) are excluded from the overlap sweep as non-terminal", () => {
    const sessions = [
      candidate({ sessionId: "s1", status: "active", entryAt: "2026-08-20T09:00:00.000Z", exitAt: null }),
      candidate({ sessionId: "s2", entryAt: "2026-08-20T09:05:00.000Z", exitAt: "2026-08-20T09:20:00.000Z" }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.size).toBe(0);
  });

  it("a single session can carry multiple anomaly tags simultaneously", () => {
    const sessions = [
      // active + entryAt older than SESSION_DURATION_MS (stale_active) + exitAt < entryAt (negative_duration)
      candidate({
        sessionId: "s1",
        status: "active",
        entryAt: "2026-08-20T07:00:00.000Z",
        exitAt: "2026-08-20T06:00:00.000Z",
      }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.get("s1")).toEqual(["negative_duration", "stale_active"]);
  });

  describe("stale_active exact boundary", () => {
    it("does not flag when entryAt is exactly SESSION_DURATION_MS old (strict >)", () => {
      const sessions = [
        // NOW (10:00) - 2h (default SESSION_DURATION_MS) = 08:00 exactly
        candidate({ sessionId: "s1", status: "active", entryAt: "2026-08-20T08:00:00.000Z", exitAt: null }),
      ];
      const result = detectSessionAnomalies(sessions, NOW);
      expect(result.size).toBe(0);
    });

    it("flags when entryAt is 1ms past the SESSION_DURATION_MS boundary", () => {
      const sessions = [
        candidate({ sessionId: "s1", status: "active", entryAt: "2026-08-20T07:59:59.999Z", exitAt: null }),
      ];
      const result = detectSessionAnomalies(sessions, NOW);
      expect(result.get("s1")).toEqual(["stale_active"]);
    });
  });

  it("negative_duration is flagged for synthetic sessions too (only overlap sweep excludes synthetic)", () => {
    const sessions = [
      candidate({
        sessionId: "s1",
        entryAt: "2026-08-20T09:10:00.000Z",
        exitAt: "2026-08-20T09:00:00.000Z",
        isSynthetic: true,
      }),
    ];
    const result = detectSessionAnomalies(sessions, NOW);
    expect(result.get("s1")).toEqual(["negative_duration"]);
  });

  describe("stale_active with stored deadlineAt", () => {
    it("prefers deadlineAt over a fresh entryAt when deadlineAt has already passed (config shortened after session creation)", () => {
      const sessions = [
        candidate({
          sessionId: "s1",
          status: "active",
          entryAt: "2026-08-20T09:55:00.000Z", // 5min ago, well within default 2h if recomputed
          exitAt: null,
          deadlineAt: "2026-08-20T09:59:00.000Z", // stored deadline already passed (1min ago)
        }),
      ];
      const result = detectSessionAnomalies(sessions, NOW);
      expect(result.get("s1")).toEqual(["stale_active"]);
    });

    it("does not flag when deadlineAt is still in the future even though entryAt-based recompute would flag (config extended after session creation)", () => {
      const sessions = [
        candidate({
          sessionId: "s1",
          status: "active",
          entryAt: "2026-08-20T07:00:00.000Z", // 3h ago, would flag under default 2h recompute
          exitAt: null,
          deadlineAt: "2026-08-20T11:00:00.000Z", // stored deadline still 1h in the future
        }),
      ];
      const result = detectSessionAnomalies(sessions, NOW);
      expect(result.size).toBe(0);
    });

    it("falls back to entryAt + SESSION_DURATION_MS when deadlineAt is missing", () => {
      const sessions = [
        candidate({
          sessionId: "s1",
          status: "active",
          entryAt: "2026-08-20T07:00:00.000Z",
          exitAt: null,
          deadlineAt: undefined,
        }),
      ];
      const result = detectSessionAnomalies(sessions, NOW);
      expect(result.get("s1")).toEqual(["stale_active"]);
    });

    it("falls back to entryAt + SESSION_DURATION_MS when deadlineAt is unparseable", () => {
      const sessions = [
        candidate({
          sessionId: "s1",
          status: "active",
          entryAt: "2026-08-20T07:00:00.000Z",
          exitAt: null,
          deadlineAt: "not-a-date",
        }),
      ];
      const result = detectSessionAnomalies(sessions, NOW);
      expect(result.get("s1")).toEqual(["stale_active"]);
    });
  });
});
