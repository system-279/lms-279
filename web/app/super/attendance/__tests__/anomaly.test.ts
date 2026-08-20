import { describe, expect, it } from "vitest";
import {
  ANOMALY_FILTER_OPTIONS,
  ANOMALY_LABELS,
  ANOMALY_TYPES,
  anomalyLabel,
  hasAnomaly,
  matchesAnomalyFilter,
} from "../_helpers/anomaly";

describe("ANOMALY_FILTER_OPTIONS", () => {
  it("2 つの選択肢 (all / anomaly_only) を持つ", () => {
    expect(ANOMALY_FILTER_OPTIONS).toHaveLength(2);
    expect(ANOMALY_FILTER_OPTIONS.map((o) => o.value)).toEqual(["all", "anomaly_only"]);
  });
});

describe("ANOMALY_TYPES", () => {
  it("3 つの異常種別を固定順で持つ", () => {
    expect(ANOMALY_TYPES).toEqual(["overlap_previous", "negative_duration", "stale_active"]);
  });
});

describe("anomalyLabel", () => {
  it("各異常種別のラベルを返す", () => {
    expect(anomalyLabel("overlap_previous")).toBe(ANOMALY_LABELS.overlap_previous);
    expect(anomalyLabel("negative_duration")).toBe(ANOMALY_LABELS.negative_duration);
    expect(anomalyLabel("stale_active")).toBe(ANOMALY_LABELS.stale_active);
  });
});

describe("hasAnomaly", () => {
  it("undefined は false", () => {
    expect(hasAnomaly(undefined)).toBe(false);
  });
  it("空配列は false", () => {
    expect(hasAnomaly([])).toBe(false);
  });
  it("1件以上の異常があれば true", () => {
    expect(hasAnomaly(["overlap_previous"])).toBe(true);
  });
});

describe("matchesAnomalyFilter", () => {
  describe("kind=all", () => {
    it("異常あり/なしどちらも表示する", () => {
      expect(matchesAnomalyFilter(["overlap_previous"], "all")).toBe(true);
      expect(matchesAnomalyFilter(undefined, "all")).toBe(true);
    });
  });

  describe("kind=anomaly_only", () => {
    it("異常ありのみ表示", () => {
      expect(matchesAnomalyFilter(["stale_active"], "anomaly_only")).toBe(true);
    });
    it("異常なし(undefined)は除外", () => {
      expect(matchesAnomalyFilter(undefined, "anomaly_only")).toBe(false);
    });
    it("異常なし(空配列)は除外", () => {
      expect(matchesAnomalyFilter([], "anomaly_only")).toBe(false);
    });
  });
});
