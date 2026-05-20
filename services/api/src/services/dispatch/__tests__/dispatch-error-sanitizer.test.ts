/**
 * dispatch-error-sanitizer の単体テスト。
 *
 * 設計仕様書 §6.5、AC-33 に対応。
 * PR #442 review Critical 2 対応 (JWT / refresh token / API key / folded MIME / UTF-8 safe truncate)
 * + pr-test-analyzer 指摘 (#5 複数行 MIME、#1 境界 truncate、#2 ya29 境界) を反映。
 *
 * PII (email / access_token / Bearer / JWT / refresh_token / API_key / MIME headers) を
 * [REDACTED] に置換し、UTF-8 safe で 1024 文字に truncate する純粋ロジック。
 */

import { describe, it, expect } from "vitest";
import { sanitizeErrorForAudit } from "../dispatch-error-sanitizer.js";

describe("sanitizeErrorForAudit", () => {
  describe("email 除去", () => {
    it("単一の email を [EMAIL] に置換する", () => {
      expect(sanitizeErrorForAudit(new Error("Send failed to alice@example.com"))).toBe(
        "Send failed to [EMAIL]",
      );
    });

    it("複数の email を全て [EMAIL] に置換する", () => {
      expect(
        sanitizeErrorForAudit(new Error("Both alice@x.com and bob@y.co.jp rejected")),
      ).toBe("Both [EMAIL] and [EMAIL] rejected");
    });

    it("ドット・ハイフン・サブドメインを含む email も置換する", () => {
      expect(sanitizeErrorForAudit(new Error("user.name+tag@sub-domain.co.jp"))).toBe(
        "[EMAIL]",
      );
    });
  });

  describe("access token (ya29) 除去", () => {
    it("Google ya29 形式 access token を [ACCESS_TOKEN] に置換する", () => {
      expect(
        sanitizeErrorForAudit(new Error("Invalid token: ya29.abc-DEF_123xyz")),
      ).toBe("Invalid token: [ACCESS_TOKEN]");
    });

    it("ya29. の後ろに本体がない単独 ya29 は誤マッチしない (regex は + で最低 1 文字要求)", () => {
      expect(sanitizeErrorForAudit(new Error("partial ya29"))).toBe("partial ya29");
    });
  });

  describe("JWT (eyJ...) 除去 (Critical 2 拡張)", () => {
    it("3-part JWT を [JWT] に置換する", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc-def_ghi";
      expect(sanitizeErrorForAudit(new Error(`token: ${jwt}`))).toBe("token: [JWT]");
    });

    it("Bearer プレフィックス付き JWT は Bearer 側で先に redaction される", () => {
      const jwt = "eyJabc.eyJdef.xyz123";
      const result = sanitizeErrorForAudit(new Error(`Authorization: Bearer ${jwt}`));
      // Bearer 側のマッチは [A-Za-z0-9_.-]+ で JWT 本体も食う
      expect(result).not.toContain("eyJ");
      expect(result).toContain("[BEARER]");
    });
  });

  describe("refresh token (1//) 除去 (Critical 2 拡張)", () => {
    it("1// 形式 refresh token を [REFRESH_TOKEN] に置換する", () => {
      expect(
        sanitizeErrorForAudit(new Error("rt: 1//0gabc_DEF-123xyz_ABCDEF")),
      ).toBe("rt: [REFRESH_TOKEN]");
    });
  });

  describe("Google API key (AIza...) 除去 (Critical 2 拡張)", () => {
    it("AIza + 35 chars 形式の API key を [API_KEY] に置換する", () => {
      // AIza + 35 文字 (合計 39 文字)
      const apiKey = "AIza" + "a".repeat(35);
      expect(sanitizeErrorForAudit(new Error(`key=${apiKey}`))).toBe("key=[API_KEY]");
    });

    it("AIza 短すぎる場合は誤マッチしない", () => {
      expect(sanitizeErrorForAudit(new Error("AIza_short"))).toBe("AIza_short");
    });
  });

  describe("Bearer token 除去", () => {
    it("Bearer プレフィックス付き token を [BEARER] に置換する", () => {
      expect(
        sanitizeErrorForAudit(new Error("Authorization header: Bearer abc.def-ghi_123")),
      ).toBe("Authorization header: [BEARER]");
    });
  });

  describe("MIME headers 除去 (pr-test-analyzer #5 反映)", () => {
    it("To: ヘッダ行は [MIME_HEADER] に厳密置換される (順序固定 assertion)", () => {
      const result = sanitizeErrorForAudit(new Error("Failed: To: recipient@example.com"));
      // 順序が MIME → ... → email なので、To: 行は [MIME_HEADER] で吸収される
      expect(result).toContain("[MIME_HEADER]");
      expect(result).not.toContain("To:");
      expect(result).not.toContain("recipient@example.com");
    });

    it("Cc/Bcc/From/Reply-To/Sender も同様に置換する", () => {
      expect(sanitizeErrorForAudit(new Error("Cc: a@b.com"))).toBe("[MIME_HEADER]");
      expect(sanitizeErrorForAudit(new Error("Bcc: c@d.com"))).toBe("[MIME_HEADER]");
      expect(sanitizeErrorForAudit(new Error("From: e@f.com"))).toBe("[MIME_HEADER]");
      expect(sanitizeErrorForAudit(new Error("Reply-To: g@h.com"))).toBe("[MIME_HEADER]");
      expect(sanitizeErrorForAudit(new Error("Sender: i@j.com"))).toBe("[MIME_HEADER]");
    });

    it("小文字 (to:) もケースインセンシティブで置換される", () => {
      const result = sanitizeErrorForAudit(new Error("to: lower@example.com"));
      expect(result).toContain("[MIME_HEADER]");
      expect(result).not.toContain("lower@example.com");
    });

    it("複数行の MIME ヘッダも全行置換される", () => {
      const input = new Error("To: a@x.com\r\nCc: b@y.com\r\nFrom: c@z.com");
      const result = sanitizeErrorForAudit(input);
      expect(result).not.toContain("a@x.com");
      expect(result).not.toContain("b@y.com");
      expect(result).not.toContain("c@z.com");
    });

    it("folded MIME ヘッダ (次行が空白で継続) も置換される", () => {
      // RFC 5322 §2.2.3 folded header
      const input = new Error("To: very.long.address@example.com,\r\n  another@example.com");
      const result = sanitizeErrorForAudit(input);
      expect(result).not.toContain("very.long.address@example.com");
      expect(result).not.toContain("another@example.com");
    });
  });

  describe("文字数上限 + UTF-8 safe truncate", () => {
    it("1024 文字を超える入力は 1024 文字に truncate する", () => {
      expect(
        sanitizeErrorForAudit(new Error("x".repeat(2000))).length,
      ).toBeLessThanOrEqual(1024);
    });

    it("1024 文字以下の入力はそのまま返す", () => {
      expect(sanitizeErrorForAudit(new Error("normal short message"))).toBe(
        "normal short message",
      );
    });

    it("UTF-8 マルチバイト文字 (日本語) を含む入力でも境界を割らない", () => {
      // 1024 code point ちょうど + 余り
      const input = new Error("あ".repeat(2000));
      const result = sanitizeErrorForAudit(input);
      // 結果は valid UTF-8 string (壊れた byte 列を含まない)
      expect(result.length).toBeLessThanOrEqual(1024);
      expect(() => Buffer.from(result, "utf-8").toString("utf-8")).not.toThrow();
    });
  });

  describe("非 Error 入力", () => {
    it("string 入力でも PII 除去対象になる", () => {
      expect(sanitizeErrorForAudit("Failed for user@example.com")).toBe(
        "Failed for [EMAIL]",
      );
    });

    it("null → 'null' 文字列として処理される", () => {
      expect(sanitizeErrorForAudit(null)).toBe("null");
    });

    it("undefined → 'undefined' 文字列として処理される", () => {
      expect(sanitizeErrorForAudit(undefined)).toBe("undefined");
    });

    it("数値入力 → String() 化される", () => {
      expect(sanitizeErrorForAudit(42)).toBe("42");
    });

    it("オブジェクト入力 → '[object Object]' になる", () => {
      expect(sanitizeErrorForAudit({ foo: "bar" })).toBe("[object Object]");
    });
  });

  describe("冪等性", () => {
    it("既に sanitize 済みの文字列は変化しない", () => {
      const sanitized = "Send failed to [EMAIL] with [ACCESS_TOKEN]";
      expect(sanitizeErrorForAudit(sanitized)).toBe(sanitized);
    });

    it("[BEARER] / [JWT] / [API_KEY] を含む sanitize 済みも変化しない", () => {
      const sanitized = "Auth [BEARER] failed, [JWT] expired, [API_KEY] revoked";
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

    it("JWT + refresh_token + API key が混在する Gaxios 風エラーメッセージ", () => {
      const input = new Error(
        "id_token=eyJabc.eyJdef.xyz refresh_token=1//tok-abc api_key=AIza" +
          "0123456789012345678901234567890abcde",
      );
      const result = sanitizeErrorForAudit(input);
      expect(result).not.toContain("eyJ");
      expect(result).not.toContain("1//tok-abc");
      expect(result).toContain("[API_KEY]");
    });
  });
});
