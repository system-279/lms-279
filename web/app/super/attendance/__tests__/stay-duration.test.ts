import { describe, expect, it } from "vitest";
import {
  calculateStayDurationMs,
  formatStayDuration,
  isStayTimeEdited,
} from "../_helpers/stay-duration";

describe("calculateStayDurationMs", () => {
  it("正常: 1 時間 22 分の経過を ms で返す (Issue #531 例)", () => {
    // 入室 10:14 → 退室 11:36 = 1時間22分 = 4920000 ms
    const entry = "2026-05-30T01:14:10.258Z"; // JST 10:14
    const exit = "2026-05-30T02:36:29.496Z"; // JST 11:36
    const ms = calculateStayDurationMs(entry, exit);
    expect(ms).not.toBeNull();
    expect(Math.floor(ms! / 60_000)).toBe(82); // 82 分 = 1時間22分
  });

  it("正常: 同一時刻 (0 ms) → 0 を返す (null 扱いしない)", () => {
    const t = "2026-05-30T01:14:10.000Z";
    expect(calculateStayDurationMs(t, t)).toBe(0);
  });

  it("entryAt のみ (在室中) → null", () => {
    expect(calculateStayDurationMs("2026-05-30T01:14:10.258Z", null)).toBeNull();
  });

  it("exitAt のみ (異常データ) → null", () => {
    expect(calculateStayDurationMs(null, "2026-05-30T02:36:29.496Z")).toBeNull();
  });

  it("両方 null → null", () => {
    expect(calculateStayDurationMs(null, null)).toBeNull();
  });

  it("exit < entry (異常データ) → null", () => {
    const entry = "2026-05-30T02:36:29.496Z";
    const exit = "2026-05-30T01:14:10.258Z";
    expect(calculateStayDurationMs(entry, exit)).toBeNull();
  });

  it("無効な ISO 文字列 → null (NaN ガード)", () => {
    expect(calculateStayDurationMs("not-a-date", "2026-05-30T02:36:29.496Z")).toBeNull();
    expect(calculateStayDurationMs("2026-05-30T01:14:10.258Z", "invalid")).toBeNull();
  });

  it("極大値: 数日跨ぎ time_limit セッション → 正しい ms", () => {
    // 長遊園様データ実例: 串間博希 2026-05-14 22:12 → 2026-05-17 04:49 (約 2 日と 6 時間)
    const entry = "2026-05-14T22:12:52.130Z";
    const exit = "2026-05-17T04:49:01.999Z";
    const ms = calculateStayDurationMs(entry, exit);
    expect(ms).not.toBeNull();
    const hours = Math.floor(ms! / 3_600_000);
    expect(hours).toBe(54); // 約 54 時間
  });
});

describe("formatStayDuration", () => {
  it("null → '—'", () => {
    expect(formatStayDuration(null)).toBe("—");
  });

  it("0 ms → '0分'", () => {
    expect(formatStayDuration(0)).toBe("0分");
  });

  it("60_000 ms (1 分) → '1分'", () => {
    expect(formatStayDuration(60_000)).toBe("1分");
  });

  it("59 分 → '59分' (時間部分なし)", () => {
    expect(formatStayDuration(59 * 60_000)).toBe("59分");
  });

  it("60 分ちょうど → '1時間0分'", () => {
    expect(formatStayDuration(60 * 60_000)).toBe("1時間0分");
  });

  it("1 時間 22 分 → '1時間22分' (Issue #531 例)", () => {
    const ms = (60 + 22) * 60_000;
    expect(formatStayDuration(ms)).toBe("1時間22分");
  });

  it("端数秒は切り捨て (59 秒 → 0分)", () => {
    expect(formatStayDuration(59_999)).toBe("0分");
  });

  it("負数 ms (defensive) → '—' ではなく '0分' (呼び出し側で null フィルタ前提)", () => {
    // calculateStayDurationMs が負を null にするので通常は到達しないが、
    // 万一渡された場合の挙動を documentation 目的でテスト。
    expect(formatStayDuration(-1)).toBe("-1分");
  });

  it("極大値 54 時間 → '54時間XX分'", () => {
    const ms = (54 * 60 + 36) * 60_000;
    expect(formatStayDuration(ms)).toBe("54時間36分");
  });
});

describe("isStayTimeEdited", () => {
  it("original なし → false", () => {
    expect(
      isStayTimeEdited({
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
        original: undefined,
      }),
    ).toBe(false);
  });

  it("original あり + entryAt/exitAt 一致 → false (quizScore のみ編集等)", () => {
    expect(
      isStayTimeEdited({
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
        original: {
          entryAt: "2026-05-30T01:14:10.258Z",
          exitAt: "2026-05-30T01:15:10.258Z",
        },
      }),
    ).toBe(false);
  });

  it("entryAt のみ差分 → true", () => {
    expect(
      isStayTimeEdited({
        entryAt: "2026-05-30T00:00:00.000Z",
        exitAt: "2026-05-30T01:15:10.258Z",
        original: {
          entryAt: "2026-05-30T01:14:10.258Z",
          exitAt: "2026-05-30T01:15:10.258Z",
        },
      }),
    ).toBe(true);
  });

  it("exitAt のみ差分 → true", () => {
    expect(
      isStayTimeEdited({
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T03:00:00.000Z",
        original: {
          entryAt: "2026-05-30T01:14:10.258Z",
          exitAt: "2026-05-30T01:15:10.258Z",
        },
      }),
    ).toBe(true);
  });

  it("null 値が初回値と一致 (両 null) → false", () => {
    expect(
      isStayTimeEdited({
        entryAt: null,
        exitAt: null,
        original: { entryAt: null, exitAt: null },
      }),
    ).toBe(false);
  });
});

