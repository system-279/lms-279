/**
 * completion-notification-mail の単体テスト。
 *
 * 設計仕様書 §7.1 / FR-5 改訂 / AC-5 / Phase 3 完了条件:
 *   - 完了通知本文が completionMessageBody + signatureName を含む
 *
 * 観点:
 *   - 件名は固定 DEFAULT_COMPLETION_SUBJECT
 *   - userName あり → 「{name} 様」宛名、空/null/undefined → 「受講者各位」フォールバック
 *   - completionMessageBody が本文に含まれる
 *   - signatureName が末尾に挿入される (区切り `---` 付き)
 *   - signatureName 空文字なら署名 block を出さない
 *   - userName / subject に CR/LF があれば throw (header injection 防御)
 *   - body 内 CR/LF は許容 (base64 エンコードされるため安全)
 */

import { describe, it, expect } from "vitest";
import {
  buildCompletionMail,
  DEFAULT_COMPLETION_SUBJECT,
} from "../completion-notification-mail.js";

const DEFAULT_BODY = "受講お疲れ様でした。全受講修了致しました。";
const DEFAULT_SIG = "DXcollege運営スタッフ";

describe("DEFAULT_COMPLETION_SUBJECT", () => {
  it("固定文字列で CR/LF を含まない", () => {
    expect(DEFAULT_COMPLETION_SUBJECT).toBe("【DXcollege】受講修了のお知らせ");
    expect(DEFAULT_COMPLETION_SUBJECT).not.toMatch(/[\r\n]/);
  });
});

describe("buildCompletionMail", () => {
  describe("件名", () => {
    it("常に DEFAULT_COMPLETION_SUBJECT を返す", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: DEFAULT_BODY,
        signatureName: DEFAULT_SIG,
      });
      expect(result.subject).toBe(DEFAULT_COMPLETION_SUBJECT);
    });
  });

  describe("宛名 (userName)", () => {
    it("userName あり → 「{name} 様」", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: DEFAULT_BODY,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body.startsWith("山田太郎 様")).toBe(true);
    });

    it("userName 空文字 → 「受講者各位」フォールバック", () => {
      const result = buildCompletionMail({
        userName: "",
        completionMessageBody: DEFAULT_BODY,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body.startsWith("受講者各位")).toBe(true);
    });

    it("userName null → 「受講者各位」フォールバック", () => {
      const result = buildCompletionMail({
        userName: null,
        completionMessageBody: DEFAULT_BODY,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body.startsWith("受講者各位")).toBe(true);
    });

    it("userName undefined → 「受講者各位」フォールバック", () => {
      const result = buildCompletionMail({
        userName: undefined,
        completionMessageBody: DEFAULT_BODY,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body.startsWith("受講者各位")).toBe(true);
    });

    it("userName 前後空白 → trim 後の名前で宛名", () => {
      const result = buildCompletionMail({
        userName: "  山田太郎  ",
        completionMessageBody: DEFAULT_BODY,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body.startsWith("山田太郎 様")).toBe(true);
    });
  });

  describe("本文 (completionMessageBody)", () => {
    it("本文設定値が body に含まれる (AC-5)", () => {
      const body = "受講お疲れ様でした。ご質問は本メールにご返信ください。";
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: body,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body).toContain(body);
    });

    it("本文の改行 (LF) は保持される", () => {
      const body = "line1\nline2\nline3";
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: body,
        signatureName: DEFAULT_SIG,
      });
      expect(result.body).toContain("line1\nline2\nline3");
    });

    it("本文末尾の余分な改行は trimEnd される", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: "本文\n\n\n",
        signatureName: DEFAULT_SIG,
      });
      // 「本文」の直後に余分な空行が連続しない (trimEnd 効果)
      expect(result.body).toContain("本文\n\n---");
    });
  });

  describe("署名 (signatureName)", () => {
    it("signatureName が末尾に区切り `---` 付きで挿入される (AC-5)", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: DEFAULT_BODY,
        signatureName: "DXcollege運営スタッフ",
      });
      expect(result.body).toMatch(/\n---\nDXcollege運営スタッフ\n?$/);
    });

    it("signatureName 空文字 → 署名 block を出さない", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: DEFAULT_BODY,
        signatureName: "",
      });
      expect(result.body).not.toContain("---");
    });

    it("signatureName 空白のみ → 署名 block を出さない", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: DEFAULT_BODY,
        signatureName: "   ",
      });
      expect(result.body).not.toContain("---");
    });
  });

  describe("ヘッダ injection 防御 (CR/LF)", () => {
    it("userName に CR/LF を含めば throw", () => {
      expect(() =>
        buildCompletionMail({
          userName: "山田\r\nBcc: evil@x.com",
          completionMessageBody: DEFAULT_BODY,
          signatureName: DEFAULT_SIG,
        }),
      ).toThrow(/userName/);
    });

    it("userName に LF のみでも throw", () => {
      expect(() =>
        buildCompletionMail({
          userName: "山田\n太郎",
          completionMessageBody: DEFAULT_BODY,
          signatureName: DEFAULT_SIG,
        }),
      ).toThrow(/userName/);
    });

    it("completionMessageBody 内の CR/LF は許容 (本文は base64 化される)", () => {
      // 本文中の CRLF は base64 安全、throw しない
      expect(() =>
        buildCompletionMail({
          userName: "山田太郎",
          completionMessageBody: "line1\r\nline2",
          signatureName: DEFAULT_SIG,
        }),
      ).not.toThrow();
    });

    it("signatureName に CR/LF を含めば throw (本文注入リスク防御、evaluator narrative)", () => {
      expect(() =>
        buildCompletionMail({
          userName: "山田太郎",
          completionMessageBody: DEFAULT_BODY,
          signatureName: "DXcollege運営スタッフ\r\n--\nfake-signature",
        }),
      ).toThrow(/signatureName/);
    });

    it("signatureName に LF のみでも throw", () => {
      expect(() =>
        buildCompletionMail({
          userName: "山田太郎",
          completionMessageBody: DEFAULT_BODY,
          signatureName: "line1\nline2",
        }),
      ).toThrow(/signatureName/);
    });
  });

  describe("構造 (順序)", () => {
    it("body 順序: 宛名 → 空行 → 本文 → 空行 → '---' → 署名 → 末尾空行", () => {
      const result = buildCompletionMail({
        userName: "山田太郎",
        completionMessageBody: "本文テスト",
        signatureName: "DXcollege運営スタッフ",
      });
      expect(result.body).toBe(
        "山田太郎 様\n\n本文テスト\n\n---\nDXcollege運営スタッフ\n",
      );
    });
  });
});
