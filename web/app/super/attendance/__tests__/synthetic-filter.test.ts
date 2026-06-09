import { describe, expect, it } from "vitest";
import {
  matchesIsSyntheticFilter,
  SYNTHETIC_KIND_OPTIONS,
} from "../_helpers/synthetic-filter";

describe("SYNTHETIC_KIND_OPTIONS", () => {
  it("3 つの選択肢 (all / synthetic_only / actual_only) を持つ", () => {
    expect(SYNTHETIC_KIND_OPTIONS).toHaveLength(3);
    expect(SYNTHETIC_KIND_OPTIONS.map((o) => o.value)).toEqual([
      "all",
      "synthetic_only",
      "actual_only",
    ]);
  });
});

describe("matchesIsSyntheticFilter", () => {
  describe("kind=all", () => {
    it("isSynthetic=true / false どちらも表示する", () => {
      expect(matchesIsSyntheticFilter(true, "all")).toBe(true);
      expect(matchesIsSyntheticFilter(false, "all")).toBe(true);
    });
  });

  describe("kind=synthetic_only", () => {
    it("isSynthetic=true のみ表示", () => {
      expect(matchesIsSyntheticFilter(true, "synthetic_only")).toBe(true);
    });
    it("isSynthetic=false は除外", () => {
      expect(matchesIsSyntheticFilter(false, "synthetic_only")).toBe(false);
    });
  });

  describe("kind=actual_only", () => {
    it("isSynthetic=false のみ表示", () => {
      expect(matchesIsSyntheticFilter(false, "actual_only")).toBe(true);
    });
    it("isSynthetic=true は除外", () => {
      expect(matchesIsSyntheticFilter(true, "actual_only")).toBe(false);
    });
  });
});
