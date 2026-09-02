import { describe, it, expect } from "vitest";
import { computeFingerprint, firstStackFrameLine, normalizeMessage } from "../fingerprint.js";

describe("normalizeMessage", () => {
  it("数値の違いだけのメッセージを同一の正規化結果に丸める", () => {
    expect(normalizeMessage("user 123 not found")).toBe(normalizeMessage("user 456 not found"));
    expect(normalizeMessage("user 123 not found")).toBe("user <n> not found");
  });

  it("UUIDの違いだけのメッセージを同一の正規化結果に丸める", () => {
    const a = normalizeMessage("tenant 550e8400-e29b-41d4-a716-446655440000 not found");
    const b = normalizeMessage("tenant 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found");
    expect(a).toBe(b);
    expect(a).toBe("tenant <uuid> not found");
  });

  it("数値もUUIDも含まないメッセージも別々の内容は別々の結果になる", () => {
    expect(normalizeMessage("Cannot read property x")).not.toBe(normalizeMessage("Cannot read property y"));
  });

  it("前後の空白をtrimする", () => {
    expect(normalizeMessage("  boom  ")).toBe("boom");
  });
});

describe("firstStackFrameLine", () => {
  it("先頭のヘッダ行(エラーメッセージ)ではなく、最初の\"at \"フレームを返す", () => {
    const frames = ["TypeError: user 123 not found", "at findUser (users.ts:10:1)", "at next (express.ts:5:5)"];
    expect(firstStackFrameLine(frames)).toBe("at findUser (users.ts:10:1)");
  });

  it("\"at \"フレームが無い場合は先頭行にフォールバックする", () => {
    expect(firstStackFrameLine(["some non-standard stack format"])).toBe(
      "some non-standard stack format"
    );
  });

  it("空配列は空文字を返す", () => {
    expect(firstStackFrameLine([])).toBe("");
  });
});

describe("computeFingerprint", () => {
  it("同じ入力からは同じfingerprintを返す（決定的）", () => {
    const a = computeFingerprint("TypeError", "at foo (a.ts:1:1)", "boom");
    const b = computeFingerprint("TypeError", "at foo (a.ts:1:1)", "boom");
    expect(a).toBe(b);
  });

  it("errorNameが異なれば別fingerprintになる", () => {
    const a = computeFingerprint("TypeError", "at foo (a.ts:1:1)", "boom");
    const b = computeFingerprint("RangeError", "at foo (a.ts:1:1)", "boom");
    expect(a).not.toBe(b);
  });

  it("スタック先頭フレームが異なれば別fingerprintになる", () => {
    const a = computeFingerprint("TypeError", "at foo (a.ts:1:1)", "boom");
    const b = computeFingerprint("TypeError", "at bar (b.ts:2:2)", "boom");
    expect(a).not.toBe(b);
  });

  it("normalizeMessage済みの正規化メッセージが同一なら、実質同一エラーとして同じfingerprintになる", () => {
    const a = computeFingerprint(
      "NotFoundError",
      firstStackFrameLine(["NotFoundError: user 123 not found", "at findUser (users.ts:10:1)"]),
      normalizeMessage("user 123 not found")
    );
    const b = computeFingerprint(
      "NotFoundError",
      firstStackFrameLine(["NotFoundError: user 456 not found", "at findUser (users.ts:10:1)"]),
      normalizeMessage("user 456 not found")
    );
    expect(a).toBe(b);
  });
});
