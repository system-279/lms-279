import { describe, expect, it } from "vitest";
import {
  calculateStayDurationMs,
  formatStayDuration,
  formatRecordStayDuration,
  isStayTimeEdited,
  stayDurationSortValue,
  SYNTHETIC_STAY_DURATION_LABEL,
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

describe("formatRecordStayDuration", () => {
  it("isSynthetic=true → SYNTHETIC_STAY_DURATION_LABEL (entryAt/exitAt 値に関わらず)", () => {
    expect(
      formatRecordStayDuration({
        isSynthetic: true,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
      }),
    ).toBe(SYNTHETIC_STAY_DURATION_LABEL);
  });

  it("isSynthetic=true + entryAt/exitAt null でも SYNTHETIC_STAY_DURATION_LABEL を維持", () => {
    expect(
      formatRecordStayDuration({ isSynthetic: true, entryAt: null, exitAt: null }),
    ).toBe(SYNTHETIC_STAY_DURATION_LABEL);
  });

  it("isSynthetic=false: 通常 session は formatStayDuration 結果と一致 (1 時間 22 分例)", () => {
    const result = formatRecordStayDuration({
      isSynthetic: false,
      entryAt: "2026-05-30T01:14:10.258Z",
      exitAt: "2026-05-30T02:36:29.496Z",
    });
    expect(result).toBe("1時間22分");
  });

  it("isSynthetic=false + entryAt null → '—' (formatStayDuration の null 経路)", () => {
    expect(
      formatRecordStayDuration({ isSynthetic: false, entryAt: null, exitAt: null }),
    ).toBe("—");
  });

  it("isSynthetic=false + exit < entry (異常) → '—'", () => {
    expect(
      formatRecordStayDuration({
        isSynthetic: false,
        entryAt: "2026-05-30T02:36:29.496Z",
        exitAt: "2026-05-30T01:14:10.258Z",
      }),
    ).toBe("—");
  });

  it("ラベルは「— (テストのみ)」固定 (表示文字列の回帰防止)", () => {
    expect(SYNTHETIC_STAY_DURATION_LABEL).toBe("— (テストのみ)");
  });

  it("isSynthetic=true + entryAt 編集済 (original 差分あり) → 通常計算", () => {
    // 編集機能で entryAt/exitAt を実時刻に修正した synthetic record。
    // provenance としての isSynthetic は維持されるが、滞在時間は編集後の値を表示する。
    const result = formatRecordStayDuration({
      isSynthetic: true,
      entryAt: "2026-05-30T01:14:10.258Z",
      exitAt: "2026-05-30T02:36:29.496Z",
      original: {
        entryAt: "2026-05-30T02:35:00.000Z", // 初回 = quiz.startedAt (1 分前)
        exitAt: "2026-05-30T02:36:29.496Z",
      },
    });
    expect(result).toBe("1時間22分");
  });

  it("isSynthetic=true + exitAt のみ編集済 (original 差分あり) → 通常計算", () => {
    const result = formatRecordStayDuration({
      isSynthetic: true,
      entryAt: "2026-05-30T01:14:10.258Z",
      exitAt: "2026-05-30T02:36:29.496Z",
      original: {
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z", // 初回 = quiz.submittedAt (1 分後)
      },
    });
    expect(result).toBe("1時間22分");
  });

  it("isSynthetic=true + original なし → SYNTHETIC_STAY_DURATION_LABEL (PR #557 投入前 / 未編集)", () => {
    // 過去 17 件 + 今後の自動補完すべて該当 (original snapshot 未付与)
    expect(
      formatRecordStayDuration({
        isSynthetic: true,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
        original: undefined,
      }),
    ).toBe(SYNTHETIC_STAY_DURATION_LABEL);
  });

  it("isSynthetic=true + original あり + entryAt/exitAt 同一値 (quizScore のみ編集等) → SYNTHETIC_STAY_DURATION_LABEL (HIGH 指摘反映)", () => {
    // quizScore/quizPassed のみ編集すると editedAt が付くが entryAt/exitAt は不変。
    // editedAt 単独判定だと「1 分滞在」が表示される問題を original 差分判定で防ぐ。
    expect(
      formatRecordStayDuration({
        isSynthetic: true,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
        original: {
          entryAt: "2026-05-30T01:14:10.258Z", // 同値 = 未編集
          exitAt: "2026-05-30T01:15:10.258Z",
        },
      }),
    ).toBe(SYNTHETIC_STAY_DURATION_LABEL);
  });

  it("isSynthetic=false + original あり → 通常計算 (#557 編集済通常 session)", () => {
    const result = formatRecordStayDuration({
      isSynthetic: false,
      entryAt: "2026-05-30T01:14:10.258Z",
      exitAt: "2026-05-30T02:36:29.496Z",
      original: {
        entryAt: "2026-05-30T01:00:00.000Z",
        exitAt: "2026-05-30T02:30:00.000Z",
      },
    });
    expect(result).toBe("1時間22分");
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

describe("stayDurationSortValue", () => {
  it("isSynthetic=true + 未編集 (original なし) → null (= 末尾配置)", () => {
    expect(
      stayDurationSortValue({
        isSynthetic: true,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
      }),
    ).toBeNull();
  });

  it("isSynthetic=true + original 同値 (quizScore のみ編集) → null (= 末尾配置、HIGH 指摘反映)", () => {
    expect(
      stayDurationSortValue({
        isSynthetic: true,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T01:15:10.258Z",
        original: {
          entryAt: "2026-05-30T01:14:10.258Z",
          exitAt: "2026-05-30T01:15:10.258Z",
        },
      }),
    ).toBeNull();
  });

  it("isSynthetic=true + original 差分あり (時刻編集済) → ms 値 (通常順序)", () => {
    expect(
      stayDurationSortValue({
        isSynthetic: true,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T02:36:29.496Z",
        original: {
          entryAt: "2026-05-30T02:35:00.000Z",
          exitAt: "2026-05-30T02:36:29.496Z",
        },
      }),
    ).toBeGreaterThan(0);
  });

  it("isSynthetic=false → ms 値 (通常 session、calculateStayDurationMs の生の ms 差分)", () => {
    // entry: 2026-05-30T01:14:10.258Z, exit: 2026-05-30T02:36:29.496Z → 4939238 ms (約 82 分)
    expect(
      stayDurationSortValue({
        isSynthetic: false,
        entryAt: "2026-05-30T01:14:10.258Z",
        exitAt: "2026-05-30T02:36:29.496Z",
      }),
    ).toBe(4939238);
  });

  it("isSynthetic=false + entryAt/exitAt null → null (異常データは末尾)", () => {
    expect(
      stayDurationSortValue({
        isSynthetic: false,
        entryAt: null,
        exitAt: null,
      }),
    ).toBeNull();
  });

  it("ソート挙動: 未編集 synthetic は実 session 後ろ、編集済 synthetic は通常順序に混在", () => {
    const records = [
      // 編集済 synthetic 1h22m
      { isSynthetic: true, entryAt: "2026-05-30T01:14:10.258Z", exitAt: "2026-05-30T02:36:29.496Z",
        original: { entryAt: "2026-05-30T02:35:00.000Z", exitAt: "2026-05-30T02:36:29.496Z" } },
      // 未編集 synthetic
      { isSynthetic: true, entryAt: "2026-05-30T08:41:00.000Z", exitAt: "2026-05-30T08:42:00.000Z" },
      // 通常 session 30 分
      { isSynthetic: false, entryAt: "2026-05-30T10:00:00.000Z", exitAt: "2026-05-30T10:30:00.000Z" },
    ];
    const sorted = [...records].sort((a, b) => {
      const av = stayDurationSortValue(a);
      const bv = stayDurationSortValue(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    });
    // 順序: 通常 30 分 → 編集済 synthetic 1h22m → 未編集 synthetic (末尾)
    expect(sorted[0].isSynthetic).toBe(false);
    expect(sorted[1].isSynthetic).toBe(true);
    expect(sorted[1].original).toBeDefined();
    expect(sorted[2].isSynthetic).toBe(true);
    expect(sorted[2].original).toBeUndefined();
  });
});
