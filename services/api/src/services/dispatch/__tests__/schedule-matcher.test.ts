/**
 * schedule-matcher の単体テスト (TDD RED)。
 *
 * 設計仕様書 §3.2、FR-2、AC-6 / AC-7 に対応。
 *
 * Cloud Scheduler は固定で毎時 JST 00 分起動。BE 側で
 * super_dispatch_settings の scheduleDaysOfWeek / scheduleHourJst と
 * 現在 JST 時刻を照合し、一致時のみ配信処理を実行する。
 *
 * 観点:
 * - JST 時刻一致判定 (曜日 + 時刻)
 * - enabled=false で常に false (kill switch)
 * - scheduleDaysOfWeek 空配列で常に false
 * - 月跨ぎ (UTC 月末 23:00 → JST 翌月 1 日 08:00 等)
 * - DST なし (JST は固定 UTC+9)
 * - 0 時 (深夜) / 23 時の境界
 */

import { describe, it, expect } from "vitest";
import { shouldRunNow } from "../schedule-matcher.js";
import type { DispatchSettings } from "@lms-279/shared-types";

function makeSettings(
  partial: Partial<DispatchSettings> = {},
): DispatchSettings {
  return {
    enabled: true,
    scheduleDaysOfWeek: [1, 4], // 月木
    scheduleHourJst: 9,
    signatureName: "DXcollege運営スタッフ",
    completionMessageBody: "test",
    senderEmail: "dxcollege@279279.net",
    updatedAt: "2026-05-20T00:00:00.000Z",
    updatedBy: "test@example.com",
    version: 1,
    ...partial,
  };
}

describe("shouldRunNow", () => {
  describe("kill switch", () => {
    it("enabled=false なら常に false", () => {
      // 月曜 09:00 JST (一致するはずの曜日・時刻)
      const now = new Date("2026-05-18T00:00:00.000Z"); // UTC 0:00 = JST 9:00
      expect(shouldRunNow(makeSettings({ enabled: false }), now)).toBe(false);
    });
  });

  describe("scheduleDaysOfWeek", () => {
    it("月曜 09:00 JST、settings 月木 09:00 → true", () => {
      const now = new Date("2026-05-18T00:00:00.000Z"); // 月曜 UTC 0:00 = JST 9:00
      expect(shouldRunNow(makeSettings(), now)).toBe(true);
    });

    it("木曜 09:00 JST、settings 月木 09:00 → true", () => {
      const now = new Date("2026-05-21T00:00:00.000Z"); // 木曜 UTC 0:00 = JST 9:00
      expect(shouldRunNow(makeSettings(), now)).toBe(true);
    });

    it("火曜 09:00 JST、settings 月木 09:00 → false (曜日不一致)", () => {
      const now = new Date("2026-05-19T00:00:00.000Z"); // 火曜
      expect(shouldRunNow(makeSettings(), now)).toBe(false);
    });

    it("scheduleDaysOfWeek 空配列 → 常に false", () => {
      const now = new Date("2026-05-18T00:00:00.000Z");
      expect(
        shouldRunNow(makeSettings({ scheduleDaysOfWeek: [] }), now),
      ).toBe(false);
    });

    it("scheduleDaysOfWeek 全曜日指定 → 全曜日で true", () => {
      const settings = makeSettings({
        scheduleDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      });
      // 日曜 09:00 JST
      expect(
        shouldRunNow(settings, new Date("2026-05-17T00:00:00.000Z")),
      ).toBe(true);
      // 土曜 09:00 JST
      expect(
        shouldRunNow(settings, new Date("2026-05-23T00:00:00.000Z")),
      ).toBe(true);
    });
  });

  describe("scheduleHourJst", () => {
    it("月曜 09:00 JST、settings 月 09:00 → true", () => {
      const now = new Date("2026-05-18T00:00:00.000Z"); // 月曜 JST 9:00
      expect(
        shouldRunNow(makeSettings({ scheduleHourJst: 9 }), now),
      ).toBe(true);
    });

    it("月曜 10:00 JST、settings 月 09:00 → false (時刻不一致)", () => {
      const now = new Date("2026-05-18T01:00:00.000Z"); // 月曜 JST 10:00
      expect(
        shouldRunNow(makeSettings({ scheduleHourJst: 9 }), now),
      ).toBe(false);
    });

    it("0 時 (深夜) JST 一致 → true", () => {
      // 月曜 JST 00:00 = 日曜 UTC 15:00
      const now = new Date("2026-05-17T15:00:00.000Z");
      expect(
        shouldRunNow(
          makeSettings({ scheduleDaysOfWeek: [1], scheduleHourJst: 0 }),
          now,
        ),
      ).toBe(true);
    });

    it("23 時 JST 一致 → true", () => {
      // 月曜 JST 23:00 = 月曜 UTC 14:00
      const now = new Date("2026-05-18T14:00:00.000Z");
      expect(
        shouldRunNow(
          makeSettings({ scheduleDaysOfWeek: [1], scheduleHourJst: 23 }),
          now,
        ),
      ).toBe(true);
    });
  });

  describe("月跨ぎ・年跨ぎ", () => {
    it("UTC 月末 23:00 → JST 翌月 1 日 08:00 (曜日変わる)", () => {
      // 2026-04-30 23:00 UTC = 2026-05-01 08:00 JST (金曜)
      const now = new Date("2026-04-30T23:00:00.000Z");
      expect(
        shouldRunNow(
          makeSettings({ scheduleDaysOfWeek: [5], scheduleHourJst: 8 }),
          now,
        ),
      ).toBe(true);
    });

    it("UTC 年末 23:00 → JST 翌年 1 日 08:00", () => {
      // 2026-12-31 23:00 UTC = 2027-01-01 08:00 JST (金曜)
      const now = new Date("2026-12-31T23:00:00.000Z");
      expect(
        shouldRunNow(
          makeSettings({ scheduleDaysOfWeek: [5], scheduleHourJst: 8 }),
          now,
        ),
      ).toBe(true);
    });
  });

  describe("複数曜日 + 複数日にわたるテスト", () => {
    it("月木の 09:00 JST に水曜 09:00 で false", () => {
      const now = new Date("2026-05-20T00:00:00.000Z"); // 水曜 JST 09:00
      expect(shouldRunNow(makeSettings(), now)).toBe(false);
    });

    it("月木の 09:00 JST に月曜 08:59 で false (時刻不一致)", () => {
      const now = new Date("2026-05-17T23:59:00.000Z"); // 月曜 JST 08:59
      expect(shouldRunNow(makeSettings(), now)).toBe(false);
    });

    it("月木の 09:00 JST に月曜 09:59 で true (時単位一致、分は無視)", () => {
      const now = new Date("2026-05-18T00:59:00.000Z"); // 月曜 JST 09:59
      expect(shouldRunNow(makeSettings(), now)).toBe(true);
    });
  });
});
