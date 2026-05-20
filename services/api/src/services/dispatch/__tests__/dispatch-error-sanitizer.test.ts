/**
 * dispatch-error-sanitizer の単体テスト (TDD RED)。
 *
 * 設計仕様書 §6.5、AC-33 に対応。
 * PII (email / access_token / Bearer / MIME headers) を [REDACTED] に置換し、
 * 1024 文字上限で truncate する純粋ロジック。
 *
 * 観点:
 * - email 正規表現マッチ (1 件 / 複数件 / 国際化 TLD は対象外)
 * - access token (ya29.* 形式) マッチ
 * - Bearer token マッチ
 * - MIME headers (To/Cc/Bcc/From) 1 行除去
 * - 上限 1024 文字での truncate
 * - 非 Error 入力 (string / null / undefined / 数値) の挙動
 * - 既に sanitize 済みの文字列は冪等
 */

import { describe, it, expect } from "vitest";
import { sanitizeErrorForAudit } from "../dispatch-error-sanitizer.js";

describe("sanitizeErrorForAudit", () => {
  describe("email 除去", () => {
    it("単一の email を [EMAIL] に置換する", () => {
      const input = new Error("Send failed to alice@example.com");
      expect(sanitizeErrorForAudit(input)).toBe("Send failed to [EMAIL]");
    });

    it("複数の email を全て [EMAIL] に置換する", () => {
      const input = new Error("Both alice@x.com and bob@y.co.jp rejected");
      expect(sanitizeErrorForAudit(input)).toBe("Both [EMAIL] and [EMAIL] rejected");
    });

    it("email 内のドット・ハイフン・サブドメインを含む形式も置換する", () => {
      const input = new Error("user.name+tag@sub-domain.co.jp");
      expect(sanitizeErrorForAudit(input)).toBe("[EMAIL]");
    });
  });

  describe("access token 除去", () => {
    it("Google ya29 形式 access token を [ACCESS_TOKEN] に置換する", () => {
      const input = new Error("Invalid token: ya29.abc-DEF_123xyz");
      expect(sanitizeErrorForAudit(input)).toBe("Invalid token: [ACCESS_TOKEN]");
    });
  });

  describe("Bearer token 除去", () => {
    it("Bearer プレフィックス付き token を [BEARER] に置換する", () => {
      const input = new Error("Authorization header: Bearer abc.def-ghi_123");
      expect(sanitizeErrorForAudit(input)).toBe("Authorization header: [BEARER]");
    });
  });

  describe("MIME headers 除去", () => {
    it("To: ヘッダ行を [MIME_HEADER] に置換する", () => {
      const input = new Error("Failed: To: recipient@example.com");
      // To: 行 + その後の email も sanitize される (順序は実装依存だが PII は残らない)
      const result = sanitizeErrorForAudit(input);
      expect(result).not.toContain("recipient@example.com");
      expect(result).toMatch(/\[MIME_HEADER\]|\[EMAIL\]/);
    });

    it("Cc/Bcc/From も同様に置換する", () => {
      expect(sanitizeErrorForAudit(new Error("Cc: a@b.com"))).not.toContain("a@b.com");
      expect(sanitizeErrorForAudit(new Error("Bcc: c@d.com"))).not.toContain("c@d.com");
      expect(sanitizeErrorForAudit(new Error("From: e@f.com"))).not.toContain("e@f.com");
    });
  });

  describe("文字数上限", () => {
    it("1024 文字を超える入力は 1024 文字に truncate する", () => {
      const longInput = new Error("x".repeat(2000));
      expect(sanitizeErrorForAudit(longInput).length).toBeLessThanOrEqual(1024);
    });

    it("1024 文字以下の入力はそのまま返す (PII 置換のみ)", () => {
      const input = new Error("normal short message");
      expect(sanitizeErrorForAudit(input)).toBe("normal short message");
    });
  });

  describe("非 Error 入力", () => {
    it("string 入力は そのまま PII 除去対象になる", () => {
      expect(sanitizeErrorForAudit("Failed for user@example.com")).toBe(
        "Failed for [EMAIL]",
      );
    });

    it("null 入力は 'null' 文字列として処理される", () => {
      expect(sanitizeErrorForAudit(null)).toBe("null");
    });

    it("undefined 入力は 'undefined' 文字列として処理される", () => {
      expect(sanitizeErrorForAudit(undefined)).toBe("undefined");
    });

    it("数値入力は String() 化される", () => {
      expect(sanitizeErrorForAudit(42)).toBe("42");
    });

    it("オブジェクト入力は String() で表現される", () => {
      expect(sanitizeErrorForAudit({ foo: "bar" })).toBe("[object Object]");
    });
  });

  describe("冪等性", () => {
    it("既に sanitize 済みの文字列は変化しない", () => {
      const sanitized = "Send failed to [EMAIL] with [ACCESS_TOKEN]";
      expect(sanitizeErrorForAudit(sanitized)).toBe(sanitized);
    });
  });

  describe("複合シナリオ", () => {
    it("email + access_token + Bearer が混在した文字列を全て除去する", () => {
      const input = new Error(
        "Auth Bearer ya29.tok-1 failed for alice@x.com (To: bob@y.com)",
      );
      const result = sanitizeErrorForAudit(input);
      expect(result).not.toContain("alice@x.com");
      expect(result).not.toContain("bob@y.com");
      expect(result).not.toContain("ya29.tok-1");
      expect(result).not.toContain("Bearer ya29");
    });
  });
});
