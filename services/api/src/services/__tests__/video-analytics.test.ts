import { describe, it, expect } from "vitest";
import {
  mergeWatchedRanges,
  calculateCoverageRatio,
  extractWatchedRangesFromEvents,
  detectSuspiciousFlags,
} from "../video-analytics.js";
import type { VideoAnalytics, VideoEvent, WatchedRange } from "../../types/entities.js";

// -----------------------------------------------
// テストデータヘルパー
// -----------------------------------------------

function makeHeartbeat(
  position: number,
  clientTimestamp: number
): Omit<VideoEvent, "id" | "timestamp"> {
  return {
    videoId: "v1",
    userId: "u1",
    sessionToken: "sess",
    eventType: "heartbeat",
    position,
    playbackRate: 1,
    clientTimestamp,
  };
}

function makeEvent(
  eventType: VideoEvent["eventType"],
  position: number,
  clientTimestamp: number,
  extra: Partial<VideoEvent> = {}
): Omit<VideoEvent, "id" | "timestamp"> {
  return {
    videoId: "v1",
    userId: "u1",
    sessionToken: "sess",
    eventType,
    position,
    playbackRate: 1,
    clientTimestamp,
    ...extra,
  };
}

function makeAnalytics(overrides: Partial<VideoAnalytics> = {}): VideoAnalytics {
  return {
    id: "u1_v1",
    videoId: "v1",
    userId: "u1",
    watchedRanges: [],
    totalWatchTimeSec: 0,
    coverageRatio: 0,
    isComplete: false,
    seekCount: 0,
    pauseCount: 0,
    totalPauseDurationSec: 0,
    speedViolationCount: 0,
    suspiciousFlags: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// -----------------------------------------------
// mergeWatchedRanges
// -----------------------------------------------

describe("mergeWatchedRanges", () => {
  it("空配列 → 空配列を返す", () => {
    expect(mergeWatchedRanges([])).toEqual([]);
  });

  it("重複なし → そのまま返す", () => {
    const input: WatchedRange[] = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];
    expect(mergeWatchedRanges(input)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it("重複あり → マージ: [{0,10}, {5,15}] → [{0,15}]", () => {
    const input: WatchedRange[] = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ];
    expect(mergeWatchedRanges(input)).toEqual([{ start: 0, end: 15 }]);
  });

  it("隣接区間 → マージ: [{0,10}, {10,20}] → [{0,20}]", () => {
    const input: WatchedRange[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    expect(mergeWatchedRanges(input)).toEqual([{ start: 0, end: 20 }]);
  });

  it("複数重複 → 正しくマージ: [{0,10}, {5,15}, {20,30}, {25,35}] → [{0,15}, {20,35}]", () => {
    const input: WatchedRange[] = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 20, end: 30 },
      { start: 25, end: 35 },
    ];
    expect(mergeWatchedRanges(input)).toEqual([
      { start: 0, end: 15 },
      { start: 20, end: 35 },
    ]);
  });

  it("ソートされていない入力 → ソート+マージ", () => {
    const input: WatchedRange[] = [
      { start: 20, end: 30 },
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ];
    expect(mergeWatchedRanges(input)).toEqual([
      { start: 0, end: 15 },
      { start: 20, end: 30 },
    ]);
  });

  it("元の配列を変更しない（immutability）", () => {
    const input: WatchedRange[] = [
      { start: 5, end: 15 },
      { start: 0, end: 10 },
    ];
    const copy = input.map((r) => ({ ...r }));
    mergeWatchedRanges(input);
    expect(input).toEqual(copy);
  });
});

// -----------------------------------------------
// calculateCoverageRatio
// -----------------------------------------------

describe("calculateCoverageRatio", () => {
  it("空ranges → 0", () => {
    expect(calculateCoverageRatio([], 100)).toBe(0);
  });

  it("全区間カバー → 1.0（上限クランプ）", () => {
    const ranges: WatchedRange[] = [{ start: 0, end: 100 }];
    expect(calculateCoverageRatio(ranges, 100)).toBe(1.0);
  });

  it("視聴範囲が動画長を超えても 1.0 にクランプ", () => {
    // マージ済みとして渡す場合でもクランプされること
    const ranges: WatchedRange[] = [{ start: 0, end: 120 }];
    expect(calculateCoverageRatio(ranges, 100)).toBe(1.0);
  });

  it("部分カバー → 正しい比率", () => {
    const ranges: WatchedRange[] = [
      { start: 0, end: 30 },
      { start: 50, end: 80 },
    ];
    // 30 + 30 = 60秒 / 120秒 = 0.5
    expect(calculateCoverageRatio(ranges, 120)).toBeCloseTo(0.5);
  });

  it("durationSec=0 → 0（ゼロ除算防止）", () => {
    const ranges: WatchedRange[] = [{ start: 0, end: 10 }];
    expect(calculateCoverageRatio(ranges, 0)).toBe(0);
  });

  it("durationSec が負 → 0（ゼロ除算防止）", () => {
    const ranges: WatchedRange[] = [{ start: 0, end: 10 }];
    expect(calculateCoverageRatio(ranges, -1)).toBe(0);
  });
});

// -----------------------------------------------
// extractWatchedRangesFromEvents
// -----------------------------------------------

describe("extractWatchedRangesFromEvents", () => {
  it("heartbeatイベントから連続区間を抽出する", () => {
    // position: 0→2→4→6→8 (各2秒差、5秒以内なので連続)
    const events = [
      makeHeartbeat(0, 0),
      makeHeartbeat(2, 2000),
      makeHeartbeat(4, 4000),
      makeHeartbeat(6, 6000),
      makeHeartbeat(8, 8000),
    ] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, []);
    expect(result).toEqual([{ start: 0, end: 8 }]);
  });

  it("heartbeatが不連続の場合は複数区間に分割される", () => {
    // 0→5秒は連続、次に20秒へジャンプ（5秒超 or 後退）
    const events = [
      makeHeartbeat(0, 0),
      makeHeartbeat(5, 5000),
      makeHeartbeat(20, 20000), // positionDiff=15 > 5 → 不連続
      makeHeartbeat(25, 25000),
    ] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, []);
    expect(result).toEqual([
      { start: 0, end: 5 },
      { start: 20, end: 25 },
    ]);
  });

  it("既存rangesとの正しいマージ", () => {
    const existing: WatchedRange[] = [{ start: 0, end: 10 }];
    // heartbeatが8→12（既存と重複）
    const events = [
      makeHeartbeat(8, 0),
      makeHeartbeat(10, 2000),
      makeHeartbeat(12, 4000),
    ] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, existing);
    // [{0,10}, {8,12}] → マージで [{0,12}]
    expect(result).toEqual([{ start: 0, end: 12 }]);
  });

  it("heartbeat以外のイベントは無視される", () => {
    const events = [
      makeEvent("play", 0, 0),
      makeEvent("pause", 10, 10000),
      makeEvent("seeked", 5, 5000),
      makeHeartbeat(0, 0),
      makeHeartbeat(3, 3000),
      makeHeartbeat(6, 6000),
    ] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, []);
    expect(result).toEqual([{ start: 0, end: 6 }]);
  });

  it("heartbeatが0件 → 既存rangesをそのまま返す", () => {
    const existing: WatchedRange[] = [{ start: 0, end: 10 }];
    const events = [makeEvent("play", 0, 0)] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, existing);
    expect(result).toEqual([{ start: 0, end: 10 }]);
  });

  it("heartbeatが1件のみ → 区間長さ0なので新規rangesに追加されない", () => {
    const events = [makeHeartbeat(5, 0)] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, []);
    // rangeStart=5, rangeEnd=5 → rangeEnd > rangeStart が false なので追加されない
    expect(result).toEqual([]);
  });

  it("clientTimestampでソートされていないheartbeatも正しく処理される", () => {
    const events = [
      makeHeartbeat(4, 4000),
      makeHeartbeat(0, 0),
      makeHeartbeat(2, 2000),
    ] as VideoEvent[];

    const result = extractWatchedRangesFromEvents(events, []);
    expect(result).toEqual([{ start: 0, end: 4 }]);
  });
});

// -----------------------------------------------
// detectSuspiciousFlags
// -----------------------------------------------

describe("detectSuspiciousFlags", () => {
  it("seekCount > 10 → excessive_seeks フラグ", () => {
    const analytics = makeAnalytics({ seekCount: 11 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).toContain("excessive_seeks");
  });

  it("seekCount = 10 → excessive_seeks フラグなし", () => {
    const analytics = makeAnalytics({ seekCount: 10 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).not.toContain("excessive_seeks");
  });

  it("30分以上視聴+pause0回 → no_pauses_long_session フラグ", () => {
    const analytics = makeAnalytics({ totalWatchTimeSec: 1801, pauseCount: 0 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).toContain("no_pauses_long_session");
  });

  it("30分未満視聴+pause0回 → no_pauses_long_session フラグなし", () => {
    const analytics = makeAnalytics({ totalWatchTimeSec: 1800, pauseCount: 0 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).not.toContain("no_pauses_long_session");
  });

  it("30分以上視聴でもpause > 0 → no_pauses_long_session フラグなし", () => {
    const analytics = makeAnalytics({ totalWatchTimeSec: 2000, pauseCount: 1 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).not.toContain("no_pauses_long_session");
  });

  it("speedViolationCount > 0 → speed_violation フラグ", () => {
    const analytics = makeAnalytics({ speedViolationCount: 1 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).toContain("speed_violation");
  });

  it("speedViolationCount = 0 → speed_violation フラグなし", () => {
    const analytics = makeAnalytics({ speedViolationCount: 0 });
    const flags = detectSuspiciousFlags(analytics, []);
    expect(flags).not.toContain("speed_violation");
  });

  it("正常な視聴 → フラグなし", () => {
    const analytics = makeAnalytics({
      seekCount: 2,
      pauseCount: 3,
      totalWatchTimeSec: 300,
      speedViolationCount: 0,
    });
    const events = [
      makeHeartbeat(0, 0),
      makeHeartbeat(3, 3000),
      makeHeartbeat(6, 6000),
    ] as VideoEvent[];

    const flags = detectSuspiciousFlags(analytics, events);
    expect(flags).toHaveLength(0);
  });

  it("visibility_hidden中のheartbeat → background_playback フラグ", () => {
    const analytics = makeAnalytics();
    const events = [
      makeEvent("visibility_hidden", 10, 10000),
      makeHeartbeat(15, 15000),
      makeEvent("visibility_visible", 20, 20000),
    ] as VideoEvent[];

    const flags = detectSuspiciousFlags(analytics, events);
    expect(flags).toContain("background_playback");
  });

  it("visibility_hidden中にheartbeatなし → background_playback フラグなし", () => {
    const analytics = makeAnalytics();
    const events = [
      makeHeartbeat(5, 5000),
      makeEvent("visibility_hidden", 10, 10000),
      makeEvent("visibility_visible", 20, 20000),
      makeHeartbeat(25, 25000),
    ] as VideoEvent[];

    const flags = detectSuspiciousFlags(analytics, events);
    expect(flags).not.toContain("background_playback");
  });

  it("10秒以内の時間差で15秒超の位置ジャンプ → position_jump フラグ", () => {
    const analytics = makeAnalytics();
    const events = [
      makeHeartbeat(0, 0),
      makeHeartbeat(30, 5000), // timeDiff=5秒, positionDiff=30秒 → ジャンプ
    ] as VideoEvent[];

    const flags = detectSuspiciousFlags(analytics, events);
    expect(flags).toContain("position_jump");
  });

  it("正常なheartbeat間隔 → position_jump フラグなし", () => {
    const analytics = makeAnalytics();
    const events = [
      makeHeartbeat(0, 0),
      makeHeartbeat(5, 5000), // timeDiff=5秒, positionDiff=5秒 → 正常
      makeHeartbeat(10, 10000),
    ] as VideoEvent[];

    const flags = detectSuspiciousFlags(analytics, events);
    expect(flags).not.toContain("position_jump");
  });
});
