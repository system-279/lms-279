import { describe, it, expect } from "vitest";
import {
  stripInvisibleChars,
  hasInvisibleChars,
  sanitizeEncodedPathnameForRedirect,
} from "../sanitize-path";

describe("stripInvisibleChars", () => {
  it("U+FE0E (VARIATION SELECTOR-15) を除去する", () => {
    expect(stripInvisibleChars("student︎")).toBe("student");
  });

  it("U+FE0F (VARIATION SELECTOR-16) を除去する", () => {
    expect(stripInvisibleChars("foo️bar")).toBe("foobar");
  });

  it("U+200B (ZWSP) を除去する", () => {
    expect(stripInvisibleChars("foo​bar")).toBe("foobar");
  });

  it("U+FEFF (BOM) を除去する", () => {
    expect(stripInvisibleChars("﻿hello")).toBe("hello");
  });

  it("U+00AD (soft hyphen) を除去する", () => {
    expect(stripInvisibleChars("co­operate")).toBe("cooperate");
  });

  it("TAG character (U+E0061) を除去する", () => {
    expect(stripInvisibleChars("test\u{E0061}")).toBe("test");
  });

  it("VARIATION SELECTOR Supplement (U+E0100) を除去する", () => {
    expect(stripInvisibleChars("a\u{E0100}b")).toBe("ab");
  });

  it("bidi control (U+202E RLO) を除去する", () => {
    expect(stripInvisibleChars("safe‮evil")).toBe("safeevil");
  });

  it("クリーンな ASCII path は変化させない", () => {
    expect(stripInvisibleChars("/atali82i/student")).toBe("/atali82i/student");
  });

  it("日本語と通常絵文字は保持する", () => {
    expect(stripInvisibleChars("こんにちは🎉")).toBe("こんにちは🎉");
  });

  it("改行・タブ・スペースは保持する", () => {
    expect(stripInvisibleChars("a\nb\tc d")).toBe("a\nb\tc d");
  });

  it("複数の不可視文字を全て除去する", () => {
    expect(stripInvisibleChars("﻿a​b︎c")).toBe("abc");
  });

  it("空文字は空文字のまま", () => {
    expect(stripInvisibleChars("")).toBe("");
  });

  it("現場事象 (Issue #456) の再現: URL path 末尾 student に U+FE0E", () => {
    const broken = "/atali82i/student︎";
    expect(stripInvisibleChars(broken)).toBe("/atali82i/student");
  });
});

describe("hasInvisibleChars", () => {
  it("U+FE0E を含む場合 true", () => {
    expect(hasInvisibleChars("student︎")).toBe(true);
  });

  it("クリーンな文字列の場合 false", () => {
    expect(hasInvisibleChars("/atali82i/student")).toBe(false);
  });

  it("空文字の場合 false", () => {
    expect(hasInvisibleChars("")).toBe(false);
  });

  it("日本語のみは false", () => {
    expect(hasInvisibleChars("受講者")).toBe(false);
  });
});

describe("INVISIBLE_CHAR_PATTERN: 範囲端点境界値", () => {
  it("U+200B (範囲下端) を除去", () => {
    expect(stripInvisibleChars("a\u{200B}b")).toBe("ab");
  });
  it("U+200F (範囲上端) を除去", () => {
    expect(stripInvisibleChars("a\u{200F}b")).toBe("ab");
  });
  it("U+2010 (範囲外 HYPHEN) は保持", () => {
    expect(stripInvisibleChars("a\u{2010}b")).toBe("a\u{2010}b");
  });
  it("U+202A (範囲下端 LRE) を除去", () => {
    expect(stripInvisibleChars("a\u{202A}b")).toBe("ab");
  });
  it("U+202E (範囲上端 RLO) を除去", () => {
    expect(stripInvisibleChars("a\u{202E}b")).toBe("ab");
  });
  it("U+202F (範囲外 NARROW NO-BREAK SPACE) は保持", () => {
    expect(stripInvisibleChars("a\u{202F}b")).toBe("a\u{202F}b");
  });
  it("U+2060 (範囲下端 WJ) を除去", () => {
    expect(stripInvisibleChars("a\u{2060}b")).toBe("ab");
  });
  it("U+2064 (範囲上端) を除去", () => {
    expect(stripInvisibleChars("a\u{2064}b")).toBe("ab");
  });
  it("U+2065 (ギャップ範囲外) は保持", () => {
    expect(stripInvisibleChars("a\u{2065}b")).toBe("a\u{2065}b");
  });
  it("U+2066 (範囲下端 LRI) を除去", () => {
    expect(stripInvisibleChars("a\u{2066}b")).toBe("ab");
  });
  it("U+206F (範囲上端) を除去", () => {
    expect(stripInvisibleChars("a\u{206F}b")).toBe("ab");
  });
  it("U+FE00 (範囲下端 VS-1) を除去", () => {
    expect(stripInvisibleChars("a\u{FE00}b")).toBe("ab");
  });
  it("U+FE10 (範囲外 CJK 句読点) は保持", () => {
    expect(stripInvisibleChars("a\u{FE10}b")).toBe("a\u{FE10}b");
  });
  it("U+E0000 (TAG 範囲下端) を除去", () => {
    expect(stripInvisibleChars("a\u{E0000}b")).toBe("ab");
  });
  it("U+E007F (TAG 範囲上端) を除去", () => {
    expect(stripInvisibleChars("a\u{E007F}b")).toBe("ab");
  });
  it("U+E01EF (VS Supplement 範囲上端) を除去", () => {
    expect(stripInvisibleChars("a\u{E01EF}b")).toBe("ab");
  });
});

describe("除去対象外の保持 (否定テスト)", () => {
  it("Arabic 文字 (U+0627) は保持", () => {
    expect(stripInvisibleChars("a\u{0627}b")).toBe("a\u{0627}b");
  });
  it("Hebrew 文字 (U+05D0) は保持", () => {
    expect(stripInvisibleChars("a\u{05D0}b")).toBe("a\u{05D0}b");
  });
  it("ASCII 制御文字 (U+0001) は保持 (現状仕様: 範囲外)", () => {
    expect(stripInvisibleChars("a\u{0001}b")).toBe("a\u{0001}b");
  });
  it("ZWJ (U+200D) は除去対象 → 絵文字合字 (👨‍👩) は破壊される (現状仕様、URL path 用なので許容)", () => {
    expect(stripInvisibleChars("👨\u{200D}👩")).toBe("👨👩");
  });
});

describe("sanitizeEncodedPathnameForRedirect", () => {
  it("末尾 segment に encoded U+FE0E を含む path は redirect 対象", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/atali82i/student%EF%B8%8E"),
    ).toEqual({
      needsRedirect: true,
      cleaned: "/atali82i/student",
    });
  });

  it("encoded ZWSP (U+200B) を含む segment も redirect", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/atali%E2%80%8B82i/student"),
    ).toEqual({
      needsRedirect: true,
      cleaned: "/atali82i/student",
    });
  });

  it("クリーンな path は redirect 不要 (cleaned は original そのまま)", () => {
    expect(sanitizeEncodedPathnameForRedirect("/atali82i/student")).toEqual({
      needsRedirect: false,
      cleaned: "/atali82i/student",
    });
  });

  it("encoded slash (%2F) は path separator に変えない", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/courses/a%2Fb/student%EF%B8%8E"),
    ).toEqual({
      needsRedirect: true,
      cleaned: "/courses/a%2Fb/student",
    });
  });

  it("encoded slash のみの path はクリーン (segment が触られない)", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/courses/a%2Fb"),
    ).toEqual({
      needsRedirect: false,
      cleaned: "/courses/a%2Fb",
    });
  });

  it("空 segment (//) を保持する", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/a//student%EF%B8%8E"),
    ).toEqual({
      needsRedirect: true,
      cleaned: "/a//student",
    });
  });

  it("不正 percent sequence を含む segment はそのまま、別 segment は救済", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/%E0%A4%A/student%EF%B8%8E"),
    ).toEqual({
      needsRedirect: true,
      cleaned: "/%E0%A4%A/student",
    });
  });

  it("ルート path はそのまま", () => {
    expect(sanitizeEncodedPathnameForRedirect("/")).toEqual({
      needsRedirect: false,
      cleaned: "/",
    });
  });

  it("日本語を含む encoded path はクリーン (除去対象なし)", () => {
    expect(
      sanitizeEncodedPathnameForRedirect("/%E5%8F%97%E8%AC%9B%E8%80%85"),
    ).toEqual({
      needsRedirect: false,
      cleaned: "/%E5%8F%97%E8%AC%9B%E8%80%85",
    });
  });
});
