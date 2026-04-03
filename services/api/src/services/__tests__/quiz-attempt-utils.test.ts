import { describe, it, expect } from "vitest";
import { countEffectiveAttempts } from "../quiz-attempt-utils.js";

describe("countEffectiveAttempts", () => {
  it("timed_outを除外してカウントする", () => {
    const attempts = [
      { status: "submitted" as const },
      { status: "timed_out" as const },
      { status: "submitted" as const },
    ];
    expect(countEffectiveAttempts(attempts)).toBe(2);
  });

  it("空配列 → 0", () => {
    expect(countEffectiveAttempts([])).toBe(0);
  });

  it("全てtimed_out → 0", () => {
    const attempts = [
      { status: "timed_out" as const },
      { status: "timed_out" as const },
    ];
    expect(countEffectiveAttempts(attempts)).toBe(0);
  });

  it("in_progressもカウントする", () => {
    const attempts = [
      { status: "in_progress" as const },
      { status: "submitted" as const },
      { status: "timed_out" as const },
    ];
    expect(countEffectiveAttempts(attempts)).toBe(2);
  });
});
