import { describe, it, expect, vi, afterEach } from "vitest";
import { isoToDatetimeLocal, datetimeLocalToISO } from "../tz-helpers";

describe("isoToDatetimeLocal", () => {
  it("null を空文字に変換する", () => {
    expect(isoToDatetimeLocal(null)).toBe("");
  });

  it("空文字を空文字に変換する", () => {
    expect(isoToDatetimeLocal("")).toBe("");
  });

  it("ISO UTC文字列をローカルdatetime-local形式に変換する", () => {
    // TZをJSTに固定してテスト
    vi.stubEnv("TZ", "Asia/Tokyo");
    const result = isoToDatetimeLocal("2026-03-30T01:00:00.000Z");
    // UTC 01:00 → JST 10:00
    expect(result).toBe("2026-03-30T10:00");
  });

  it("日付をまたぐケース（UTC夕方→JST翌日早朝）", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const result = isoToDatetimeLocal("2026-03-29T18:00:00.000Z");
    // UTC 18:00 → JST 翌日 03:00
    expect(result).toBe("2026-03-30T03:00");
  });
});

describe("datetimeLocalToISO", () => {
  it("datetime-local値をISO UTC文字列に変換する", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const result = datetimeLocalToISO("2026-03-30T10:00");
    // JST 10:00 → UTC 01:00
    expect(result).toBe("2026-03-30T01:00:00.000Z");
  });

  it("空文字でRangeErrorをthrowする", () => {
    expect(() => datetimeLocalToISO("")).toThrow(RangeError);
  });
});

describe("ラウンドトリップ", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ISO → datetime-local → ISO でラウンドトリップが成立する", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const original = "2026-03-30T01:00:00.000Z";
    const local = isoToDatetimeLocal(original);
    const roundTripped = datetimeLocalToISO(local);
    expect(roundTripped).toBe(original);
  });

  it("異なるTZ（UTC）でもラウンドトリップが成立する", () => {
    vi.stubEnv("TZ", "UTC");
    const original = "2026-06-15T14:30:00.000Z";
    const local = isoToDatetimeLocal(original);
    expect(local).toBe("2026-06-15T14:30");
    const roundTripped = datetimeLocalToISO(local);
    expect(roundTripped).toBe(original);
  });
});
