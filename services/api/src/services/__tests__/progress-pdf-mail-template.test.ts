/**
 * progress-pdf-mail-template の単体テスト。
 *
 * 観点:
 * - ProgressPdfData の集約 → メール件名・本文の組み立て
 * - pace.status 5 状態それぞれの deadlineSummary / paceSummary
 * - JST 日付変換 (ADR-029)
 * - 進捗率の整数パーセント丸め
 * - 受講者名が null の場合 email にフォールバック
 */

import { describe, it, expect } from "vitest";
import type { Pace, ProgressPdfData } from "@lms-279/shared-types";
import {
  buildMailTemplate,
  calculateOverallProgressPercent,
  formatDeadlineSummary,
  formatPaceSummary,
  __internal,
} from "../progress-pdf-mail-template.js";

const { toJstDate, stripCRLF } = __internal;

function makeData(overrides?: Partial<ProgressPdfData>): ProgressPdfData {
  const base: ProgressPdfData = {
    generatedAt: "2026-05-14T03:00:00.000Z", // JST: 2026-05-14 12:00
    user: { id: "u1", name: "山田 太郎", email: "yamada@example.com" },
    tenant: { id: "t1", name: "莞爾会 長遊園", ownerEmail: "owner@example.com" },
    deadline: {
      enrolledAt: "2026-04-01T00:00:00.000Z",
      deadlineBaseDate: "2026-04-01",
      videoAccessUntil: "2026-06-30T14:59:59.000Z", // JST: 2026-06-30 末
      quizAccessUntil: "2026-07-31T14:59:59.000Z",
      daysRemainingVideo: 47,
      daysRemainingQuiz: 78,
    },
    courses: [
      {
        courseId: "c1",
        courseName: "コース 1",
        completedLessons: 3,
        totalLessons: 10,
        progressRatio: 0.3,
        isCompleted: false,
        lessons: [],
      },
    ],
    pace: {
      status: "ongoing",
      remainingLessons: 7,
      remainingDays: 47,
      lessonsPerWeek: 2,
      minutesPerDay: 30,
    },
    videoSummary: { totalWatchedSec: 1800, totalDurationSec: 6000 },
  };
  return { ...base, ...overrides };
}

describe("toJstDate", () => {
  it("UTC 00:00 を JST 09:00 として同日扱い", () => {
    expect(toJstDate("2026-05-14T00:00:00.000Z")).toBe("2026-05-14");
  });

  it("UTC 15:00 翌日にローテする (JST 00:00)", () => {
    expect(toJstDate("2026-05-13T15:00:00.000Z")).toBe("2026-05-14");
  });

  it("不正な ISO 文字列は — を返す", () => {
    expect(toJstDate("not-a-date")).toBe("—");
  });

  it("月初・年初は 0 padding される", () => {
    expect(toJstDate("2026-01-01T00:00:00.000Z")).toBe("2026-01-01");
  });
});

describe("calculateOverallProgressPercent", () => {
  it("複数コースを集計して整数パーセントを返す", () => {
    const data = makeData({
      courses: [
        { courseId: "c1", courseName: "A", completedLessons: 3, totalLessons: 10, progressRatio: 0.3, isCompleted: false, lessons: [] },
        { courseId: "c2", courseName: "B", completedLessons: 5, totalLessons: 10, progressRatio: 0.5, isCompleted: false, lessons: [] },
      ],
    });
    const result = calculateOverallProgressPercent(data);
    expect(result.percent).toBe(40); // 8/20 = 40%
    expect(result.completedLessons).toBe(8);
    expect(result.totalLessons).toBe(20);
  });

  it("totalLessons=0 のとき percent=0 を返す (NaN にしない)", () => {
    const data = makeData({ courses: [] });
    const result = calculateOverallProgressPercent(data);
    expect(result.percent).toBe(0);
    expect(result.totalLessons).toBe(0);
  });

  it("33.3% を 33 に丸める (Math.round 標準)", () => {
    const data = makeData({
      courses: [
        { courseId: "c1", courseName: "A", completedLessons: 1, totalLessons: 3, progressRatio: 0.333, isCompleted: false, lessons: [] },
      ],
    });
    expect(calculateOverallProgressPercent(data).percent).toBe(33);
  });
});

describe("formatDeadlineSummary", () => {
  it("completed: 全レッスン完了済み", () => {
    const data = makeData({
      pace: { status: "completed", remainingLessons: 0, remainingDays: null, lessonsPerWeek: null, minutesPerDay: null },
    });
    expect(formatDeadlineSummary(data)).toBe("全レッスン完了済み");
  });

  it("expired_both: 受講期限切れ", () => {
    const data = makeData({
      pace: { status: "expired_both", remainingLessons: 5, remainingDays: null, lessonsPerWeek: null, minutesPerDay: null },
    });
    expect(formatDeadlineSummary(data)).toBe("受講期限切れ");
  });

  it("expired_video: 動画期限切れ + テスト期限を表示", () => {
    const data = makeData({
      pace: { status: "expired_video", remainingLessons: 3, remainingDays: 10, lessonsPerWeek: null, minutesPerDay: null },
    });
    expect(formatDeadlineSummary(data)).toBe("動画期限切れ (2026-07-31 までテスト受験可)");
  });

  it("expired_quiz: テスト期限切れ + 動画期限を表示", () => {
    const data = makeData({
      pace: { status: "expired_quiz", remainingLessons: 3, remainingDays: 10, lessonsPerWeek: 2, minutesPerDay: null },
    });
    expect(formatDeadlineSummary(data)).toBe("テスト期限切れ (2026-06-30 まで動画視聴可)");
  });

  it("ongoing: 両期限を併記 + 残り日数", () => {
    const data = makeData(); // ongoing デフォルト
    expect(formatDeadlineSummary(data)).toBe("2026-06-30 / 2026-07-31 まで (残り 47 日)");
  });

  it("ongoing で videoAccessUntil 単独設定の場合 単一日付を表示", () => {
    const data = makeData({
      deadline: {
        enrolledAt: null, deadlineBaseDate: null,
        videoAccessUntil: "2026-06-30T14:59:59.000Z",
        quizAccessUntil: null,
        daysRemainingVideo: 47, daysRemainingQuiz: null,
      },
    });
    expect(formatDeadlineSummary(data)).toBe("2026-06-30 まで (残り 47 日)");
  });
});

describe("formatPaceSummary", () => {
  const cases: Array<[Pace, string]> = [
    [{ status: "completed", remainingLessons: 0, remainingDays: null, lessonsPerWeek: null, minutesPerDay: null }, "完了"],
    [{ status: "expired_both", remainingLessons: 5, remainingDays: null, lessonsPerWeek: null, minutesPerDay: null }, "期限切れ (再計画が必要)"],
    [{ status: "expired_video", remainingLessons: 3, remainingDays: 10, lessonsPerWeek: null, minutesPerDay: null }, "動画期限切れ (テストのみ受験可)"],
    [{ status: "expired_quiz", remainingLessons: 3, remainingDays: 10, lessonsPerWeek: 2, minutesPerDay: null }, "週 2 レッスン (動画視聴のみ)"],
    [{ status: "ongoing", remainingLessons: 7, remainingDays: 47, lessonsPerWeek: 2, minutesPerDay: 30 }, "週 2 レッスン / 1 日あたり 30 分"],
  ];

  it.each(cases)("status=%s で正しい文言を返す", (pace, expected) => {
    expect(formatPaceSummary(pace)).toBe(expected);
  });
});

describe("stripCRLF (ヘッダインジェクション防御)", () => {
  it("CR/LF を空白に置換して trim", () => {
    expect(stripCRLF("Hello\r\nBcc: x@evil.com")).toBe("Hello Bcc: x@evil.com");
    expect(stripCRLF("a\rb\nc\r\nd")).toBe("a b c d");
  });

  it("CR/LF を含まない文字列はそのまま返す", () => {
    expect(stripCRLF("Hello World")).toBe("Hello World");
  });

  it("前後の空白も削除", () => {
    expect(stripCRLF("  Hello  ")).toBe("Hello");
  });
});

describe("buildMailTemplate ヘッダインジェクション防御 (件名・本文)", () => {
  it("tenant.name に CR/LF を含んでも件名行に CR/LF が混入しない", () => {
    const data = makeData();
    data.tenant.name = "莞爾会\r\nBcc: attacker@evil.com";
    const result = buildMailTemplate({ data, senderName: "管理者" });
    // 核心: 件名行を物理的に分断する CR/LF が消されていれば MIME インジェクションは成立しない
    // (Bcc: 文字列自体が件名に残っても、ただの件名文字列として表示されるだけで害はない)
    expect(result.subject).not.toContain("\r");
    expect(result.subject).not.toContain("\n");
  });

  it("user.name に CR/LF を含んでも件名行に注入されない", () => {
    const data = makeData();
    data.user.name = "山田\r\n太郎";
    const result = buildMailTemplate({ data, senderName: "管理者" });
    expect(result.subject).not.toContain("\r");
    expect(result.subject).not.toContain("\n");
  });

  it("senderName に CR/LF を含んでも本文末尾に注入されない", () => {
    const result = buildMailTemplate({
      data: makeData(),
      senderName: "管理者\r\n--\r\nBcc: x@evil",
    });
    const lines = result.body.split("\r\n");
    // 最後の行に CR が混入していないこと
    expect(lines[lines.length - 1]).not.toContain("\r");
    expect(lines[lines.length - 1]).not.toContain("\n");
    // 本文中に Bcc 注入が残らないこと (raw な \r\n がないこと)
    expect(result.body.match(/\nBcc:/i)).toBeNull();
  });
});

describe("buildMailTemplate", () => {
  it("件名にテナント名・受講者名・JST 日付を含む", () => {
    const result = buildMailTemplate({ data: makeData(), senderName: "管理者 太郎" });
    expect(result.subject).toBe("【莞爾会 長遊園】山田 太郎 さんの受講進捗レポート (2026-05-14)");
  });

  it("受講者名が null のとき email にフォールバック", () => {
    const data = makeData();
    data.user.name = null;
    const result = buildMailTemplate({ data, senderName: "管理者" });
    expect(result.subject).toContain("yamada@example.com");
    expect(result.body).toContain("yamada@example.com");
  });

  it("本文に進捗率・期限・推奨ペース・送信者名を含む", () => {
    const result = buildMailTemplate({ data: makeData(), senderName: "管理者 太郎" });
    expect(result.body).toContain("進捗率: 30% (3/10 レッスン完了)");
    expect(result.body).toContain("2026-06-30 / 2026-07-31 まで (残り 47 日)");
    expect(result.body).toContain("週 2 レッスン / 1 日あたり 30 分");
    expect(result.body).toContain("管理者 太郎");
  });

  it("本文末尾に送信者名が単独行で配置される (CRLF 区切り)", () => {
    const result = buildMailTemplate({ data: makeData(), senderName: "山田" });
    const lines = result.body.split("\r\n");
    expect(lines[lines.length - 1]).toBe("山田");
  });

  it("completed 状態でも違和感のない文面になる", () => {
    const data = makeData({
      pace: { status: "completed", remainingLessons: 0, remainingDays: null, lessonsPerWeek: null, minutesPerDay: null },
      courses: [{ courseId: "c1", courseName: "A", completedLessons: 10, totalLessons: 10, progressRatio: 1.0, isCompleted: true, lessons: [] }],
    });
    const result = buildMailTemplate({ data, senderName: "管理者" });
    expect(result.body).toContain("進捗率: 100% (10/10 レッスン完了)");
    expect(result.body).toContain("受講期限: 全レッスン完了済み");
    expect(result.body).toContain("推奨ペース: 完了");
  });
});
