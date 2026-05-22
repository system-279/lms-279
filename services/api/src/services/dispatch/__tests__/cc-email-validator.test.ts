/**
 * cc-email-validator の単体テスト。
 *
 * 設計仕様書 §3.x、FR-6、AC-4 / AC-20 / AC-21 / AC-25 に対応。
 * Codex Important-6 反映: CRLF / カンマ / 制御文字を含む CC を個別に除外、
 * 有効要素のみ MIME に乗せる。
 *
 * 観点:
 *   - validateSingleEmail: empty / crlf / comma / control / format / 正常
 *   - ownerEmail null + cc 非空 → CC は cc のみ (AC-20)
 *   - ownerEmail あり + cc 空 → CC は owner のみ (AC-21)
 *   - ownerEmail と cc の重複は dedup される (owner 優先)
 *   - case-insensitive dedup (Alice@x.com vs alice@x.com)
 *   - 一部不正要素は invalidEntries に分離、有効要素は通る
 *   - 順序: owner → cc 入力順
 */

import { describe, it, expect } from "vitest";
import {
  validateSingleEmail,
  validateAndDedupeCcEmails,
} from "../cc-email-validator.js";

describe("validateSingleEmail", () => {
  describe("正常系", () => {
    it("一般形式の email を ok で返す", () => {
      expect(validateSingleEmail("alice@example.com")).toEqual({
        ok: true,
        value: "alice@example.com",
      });
    });

    it("前後の空白を trim する", () => {
      expect(validateSingleEmail("  bob@example.co.jp  ")).toEqual({
        ok: true,
        value: "bob@example.co.jp",
      });
    });

    it("プラス記号・ドット・ハイフンを含む email を受理", () => {
      expect(validateSingleEmail("user.name+tag@sub-domain.co.jp")).toEqual({
        ok: true,
        value: "user.name+tag@sub-domain.co.jp",
      });
    });
  });

  describe("empty", () => {
    it("空文字は empty", () => {
      expect(validateSingleEmail("")).toEqual({ ok: false, reason: "empty" });
    });
    it("空白のみは empty (trim 後)", () => {
      expect(validateSingleEmail("   ")).toEqual({ ok: false, reason: "empty" });
    });
    it("string 以外は empty", () => {
      expect(validateSingleEmail(null)).toEqual({ ok: false, reason: "empty" });
      expect(validateSingleEmail(undefined)).toEqual({ ok: false, reason: "empty" });
      expect(validateSingleEmail(123)).toEqual({ ok: false, reason: "empty" });
    });
  });

  describe("crlf (MIME ヘッダ注入防止)", () => {
    it("内部 \\r は crlf", () => {
      expect(validateSingleEmail("alice@x.com\rBcc: evil@x.com")).toEqual({
        ok: false,
        reason: "crlf",
      });
    });
    it("内部 \\n は crlf", () => {
      expect(validateSingleEmail("alice@x.com\nBcc: evil@x.com")).toEqual({
        ok: false,
        reason: "crlf",
      });
    });
    it("内部 \\r\\n は crlf", () => {
      expect(validateSingleEmail("alice@x.com\r\nBcc: evil@x.com")).toEqual({
        ok: false,
        reason: "crlf",
      });
    });
  });

  describe("comma (複数宛先誤入力)", () => {
    it("カンマは comma", () => {
      expect(validateSingleEmail("alice@x.com,bob@x.com")).toEqual({
        ok: false,
        reason: "comma",
      });
    });
  });

  describe("control (C0 / DEL)", () => {
    it("NUL (\\x00) は control", () => {
      expect(validateSingleEmail("alice@\x00.com")).toEqual({
        ok: false,
        reason: "control",
      });
    });
    it("DEL (\\x7f) は control", () => {
      expect(validateSingleEmail("alice@x\x7f.com")).toEqual({
        ok: false,
        reason: "control",
      });
    });
  });

  describe("format", () => {
    it("@ なしは format", () => {
      expect(validateSingleEmail("alice.example.com")).toEqual({
        ok: false,
        reason: "format",
      });
    });
    it("local-part なしは format", () => {
      expect(validateSingleEmail("@example.com")).toEqual({
        ok: false,
        reason: "format",
      });
    });
    it("ドメインに . なしは format", () => {
      expect(validateSingleEmail("alice@localhost")).toEqual({
        ok: false,
        reason: "format",
      });
    });
    it("空白を含むは format", () => {
      expect(validateSingleEmail("alice @x.com")).toEqual({
        ok: false,
        reason: "format",
      });
    });
  });
});

describe("validateAndDedupeCcEmails", () => {
  describe("ownerEmail のみ", () => {
    it("owner あり + cc 空 → owner のみ (AC-21)", () => {
      expect(validateAndDedupeCcEmails([], "owner@x.com")).toEqual({
        validCcEmails: ["owner@x.com"],
        invalidEntries: [],
      });
    });

    it("owner null + cc 空 → 全空", () => {
      expect(validateAndDedupeCcEmails([], null)).toEqual({
        validCcEmails: [],
        invalidEntries: [],
      });
    });

    it("owner undefined + cc 空 → 全空 (null 同等扱い)", () => {
      expect(validateAndDedupeCcEmails([], undefined)).toEqual({
        validCcEmails: [],
        invalidEntries: [],
      });
    });
  });

  describe("notificationCcEmails のみ (AC-20)", () => {
    it("owner null + cc 1 件 → cc のみ", () => {
      expect(validateAndDedupeCcEmails(["cc1@x.com"], null)).toEqual({
        validCcEmails: ["cc1@x.com"],
        invalidEntries: [],
      });
    });

    it("owner null + cc 複数 → cc 入力順", () => {
      expect(
        validateAndDedupeCcEmails(["b@x.com", "a@x.com", "c@x.com"], null),
      ).toEqual({
        validCcEmails: ["b@x.com", "a@x.com", "c@x.com"],
        invalidEntries: [],
      });
    });
  });

  describe("owner + cc 組み合わせ", () => {
    it("owner 先頭 + cc 入力順", () => {
      const result = validateAndDedupeCcEmails(
        ["cc1@x.com", "cc2@x.com"],
        "owner@x.com",
      );
      expect(result.validCcEmails).toEqual([
        "owner@x.com",
        "cc1@x.com",
        "cc2@x.com",
      ]);
      expect(result.invalidEntries).toEqual([]);
    });
  });

  describe("dedup (case-insensitive)", () => {
    it("owner と cc が同一 email → owner を採用、cc 側 dedup", () => {
      const result = validateAndDedupeCcEmails(["owner@x.com"], "owner@x.com");
      expect(result.validCcEmails).toEqual(["owner@x.com"]);
    });

    it("owner と cc の casing 違いは同一扱い (owner casing 採用)", () => {
      const result = validateAndDedupeCcEmails(["OWNER@X.COM"], "Owner@x.com");
      expect(result.validCcEmails).toEqual(["Owner@x.com"]);
    });

    it("cc 内重複は先勝ち", () => {
      const result = validateAndDedupeCcEmails(
        ["alice@x.com", "ALICE@X.COM", "bob@x.com"],
        null,
      );
      expect(result.validCcEmails).toEqual(["alice@x.com", "bob@x.com"]);
    });
  });

  describe("一部不正要素の除外 (Important-6)", () => {
    it("CRLF を含む cc 1 件 + 有効 cc 1 件 → 有効のみ採用、invalidEntries に CRLF 件", () => {
      const result = validateAndDedupeCcEmails(
        ["good@x.com", "evil@x.com\nBcc: leak@x.com"],
        null,
      );
      expect(result.validCcEmails).toEqual(["good@x.com"]);
      expect(result.invalidEntries).toEqual([
        {
          input: "evil@x.com\nBcc: leak@x.com",
          reason: "crlf",
          source: "cc",
        },
      ]);
    });

    it("複数の reason が混在しても全件 invalidEntries に記録", () => {
      const result = validateAndDedupeCcEmails(
        ["good@x.com", "no-at-mark", "alice@x.com,bob@x.com", ""],
        null,
      );
      expect(result.validCcEmails).toEqual(["good@x.com"]);
      expect(result.invalidEntries).toEqual([
        { input: "no-at-mark", reason: "format", source: "cc" },
        { input: "alice@x.com,bob@x.com", reason: "comma", source: "cc" },
        { input: "", reason: "empty", source: "cc" },
      ]);
    });

    it("owner が不正 + cc 有効 → cc のみ採用、owner は invalidEntries source=owner", () => {
      const result = validateAndDedupeCcEmails(
        ["cc@x.com"],
        "broken@x.com\nBcc: evil@x.com",
      );
      expect(result.validCcEmails).toEqual(["cc@x.com"]);
      expect(result.invalidEntries).toEqual([
        {
          input: "broken@x.com\nBcc: evil@x.com",
          reason: "crlf",
          source: "owner",
        },
      ]);
    });
  });
});
