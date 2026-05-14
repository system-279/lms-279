import { describe, it, expect } from "vitest";
import { buildProgressPdfFilename } from "@lms-279/shared-types";

describe("buildProgressPdfFilename (Issue #366)", () => {
  it("AC-1: 日本語名はそのまま保持される", () => {
    const filename = buildProgressPdfFilename({
      name: "山田 太郎",
      email: "y@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-山田 太郎-2026-05-14.pdf");
    expect(filename).not.toMatch(/_{3,}/);
  });

  it("AC-1: 単純な日本語名 (テスト) で ___ にならない", () => {
    const filename = buildProgressPdfFilename({
      name: "テスト",
      email: "test@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-テスト-2026-05-14.pdf");
    expect(filename).not.toContain("___");
  });

  it("AC-2: name が null なら email にフォールバック", () => {
    const filename = buildProgressPdfFilename({
      name: null,
      email: "user@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-user@example.com-2026-05-14.pdf");
  });

  it("AC-2: name が undefined なら email にフォールバック", () => {
    const filename = buildProgressPdfFilename({
      name: undefined,
      email: "user@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-user@example.com-2026-05-14.pdf");
  });

  it("AC-2: name が空文字なら email にフォールバック", () => {
    const filename = buildProgressPdfFilename({
      name: "",
      email: "user@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-user@example.com-2026-05-14.pdf");
  });

  it("AC-2: name が空白文字のみなら email にフォールバック", () => {
    const filename = buildProgressPdfFilename({
      name: "   ",
      email: "user@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-user@example.com-2026-05-14.pdf");
  });

  it("AC-3: OS unsafe 文字 (/, \\, :, *, ?, \", <, >, |) は _ に置換", () => {
    const filename = buildProgressPdfFilename({
      name: 'a/b\\c:d*e?f"g<h>i|j',
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-a_b_c_d_e_f_g_h_i_j-2026-05-14.pdf");
  });

  it("AC-3: 制御文字 (CR/LF) は _ に置換", () => {
    const filename = buildProgressPdfFilename({
      name: "line1\r\nline2",
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-line1_line2-2026-05-14.pdf");
  });

  it("AC-3: 連続する _ は 1 つに圧縮", () => {
    const filename = buildProgressPdfFilename({
      name: "a///b",
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-a_b-2026-05-14.pdf");
  });

  it("AC-4: name が全て危険文字なら email にフォールバック", () => {
    const filename = buildProgressPdfFilename({
      name: "///",
      email: "user@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-user@example.com-2026-05-14.pdf");
  });

  it("英数字とドット・ハイフン・アンダースコアは保持される", () => {
    const filename = buildProgressPdfFilename({
      name: "John_Doe-2024.v1",
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-John_Doe-2024.v1-2026-05-14.pdf");
  });

  it("名前先頭/末尾のドット・アンダースコアはトリム", () => {
    const filename = buildProgressPdfFilename({
      name: ".._Alice_..",
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe("progress-Alice-2026-05-14.pdf");
  });

  it("極端に長い日本語名は 50 code unit で truncate される (ファイル名長制限対策)", () => {
    const longName = "あ".repeat(200); // UTF-8 で約 600 bytes
    const filename = buildProgressPdfFilename({
      name: longName,
      email: "x@example.com",
      date: "2026-05-14",
    });
    // `progress-` (9) + あ × 50 (50 code units) + `-2026-05-14.pdf` (15) = 74 code units
    expect(filename).toBe(`progress-${"あ".repeat(50)}-2026-05-14.pdf`);
    // UTF-8 で日本語 50 文字 ≒ 150 bytes、全体で 174 bytes と 255 byte 上限内
    expect(Buffer.byteLength(filename, "utf-8")).toBeLessThan(255);
  });

  it("極端に長い ASCII 名も 50 文字で truncate", () => {
    const longName = "a".repeat(200);
    const filename = buildProgressPdfFilename({
      name: longName,
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe(`progress-${"a".repeat(50)}-2026-05-14.pdf`);
  });

  // Codex review 指摘: UTF-16 code unit slice はサロゲートペアを分断し、後段
  // encodeURIComponent で URIError を投げて HTTP 500 になる。code point 単位で
  // truncate することで境界が常に valid な UTF-16 / UTF-8 になることを保証する。
  it("サロゲートペア (絵文字) を含む name で lone surrogate を生成しない", () => {
    const filename = buildProgressPdfFilename({
      name: "😀".repeat(100), // 100 code points = 200 UTF-16 code units
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe(`progress-${"😀".repeat(50)}-2026-05-14.pdf`);
    // encodeURIComponent で URIError が出ないこと (lone surrogate 不在の証明)
    expect(() => encodeURIComponent(filename)).not.toThrow();
  });

  it("BMP 外文字を 50 code point 境界に持つ name も valid な UTF-16 を保つ", () => {
    // 49 BMP 文字 + 1 絵文字 (UTF-16 で 2 code unit) → 全体 51 code unit だが 50 code point
    const name = "a".repeat(49) + "😀" + "extra";
    const filename = buildProgressPdfFilename({
      name,
      email: "x@example.com",
      date: "2026-05-14",
    });
    expect(filename).toBe(`progress-${"a".repeat(49)}😀-2026-05-14.pdf`);
    expect(() => encodeURIComponent(filename)).not.toThrow();
  });
});
