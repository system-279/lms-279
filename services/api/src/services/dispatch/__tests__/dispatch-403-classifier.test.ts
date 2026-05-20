/**
 * dispatch-403-classifier の単体テスト。
 *
 * 設計仕様書 §6.4、Codex Important-4 (403 reason 分類) に対応。
 * PR #442 review 後の改修反映:
 *   - Critical 1 (forbidden 独断追加除去)
 *   - Critical 4 (errors.some() で複数 reason 取りこぼし防止)
 *   - Critical 5 (HTTP 403 ガード、非 403 で throw)
 *
 * Gmail API 403 を 2 つに分類:
 * - scope_revoked (全体中断): insufficientPermissions / delegationDenied / userRateLimitExceeded
 * - user_permanent (宛先固有): その他 (受講者の Gmail 受信拒否設定 / recipientRejected / forbidden 等)
 *
 * 観点:
 * - HTTP 403 専用、403 以外は throw (呼び出し側のバグ検知)
 * - GaxiosError 形式の data.error.errors[] を全件走査 (errors.some())
 * - 既知の scope_revoked reasons 3 つ
 * - reason が未定義 / errors 配列空 / data 不在 → user_permanent (デフォルト宛先固有)
 * - 複数 reason のうち 1 つでも scope_revoked にマッチすれば scope_revoked
 */

import { describe, it, expect } from "vitest";
import { classifyGmail403 } from "../dispatch-403-classifier.js";

function makeGaxios(
  status: number,
  reasons: Array<string | undefined> = [],
): Error {
  const err = new Error(`${status} error`) as Error & {
    response?: { status?: number; data?: unknown };
  };
  err.response = {
    status,
    data: {
      error: {
        errors: reasons.map((reason) => (reason ? { reason } : {})),
      },
    },
  };
  return err;
}

describe("classifyGmail403", () => {
  describe("scope_revoked (run 全体中断、設計仕様書 §6.4 記載 3 reason のみ)", () => {
    it("insufficientPermissions → scope_revoked", () => {
      expect(classifyGmail403(makeGaxios(403, ["insufficientPermissions"]))).toBe(
        "scope_revoked",
      );
    });

    it("delegationDenied → scope_revoked", () => {
      expect(classifyGmail403(makeGaxios(403, ["delegationDenied"]))).toBe(
        "scope_revoked",
      );
    });

    it("userRateLimitExceeded → scope_revoked (sender disabled 系)", () => {
      expect(
        classifyGmail403(makeGaxios(403, ["userRateLimitExceeded"])),
      ).toBe("scope_revoked");
    });
  });

  describe("user_permanent (宛先固有)", () => {
    it("forbidden → user_permanent (仕様書未記載のため scope_revoked にしない)", () => {
      // Codex Critical-1 対応: AI 越権で SCOPE_REVOKED_REASONS に追加していた forbidden を除去。
      // 仕様書 §6.4 は 3 reason のみで、forbidden は組織側拒否ポリシー等でも返るため宛先固有扱い。
      expect(classifyGmail403(makeGaxios(403, ["forbidden"]))).toBe("user_permanent");
    });

    it("recipientRejected → user_permanent", () => {
      expect(classifyGmail403(makeGaxios(403, ["recipientRejected"]))).toBe(
        "user_permanent",
      );
    });

    it("未知の reason → user_permanent (デフォルト安全側)", () => {
      expect(classifyGmail403(makeGaxios(403, ["someUnknownReason"]))).toBe(
        "user_permanent",
      );
    });

    it("reason undefined → user_permanent", () => {
      expect(classifyGmail403(makeGaxios(403, [undefined]))).toBe("user_permanent");
    });

    it("errors 配列空 → user_permanent", () => {
      expect(classifyGmail403(makeGaxios(403, []))).toBe("user_permanent");
    });
  });

  describe("複数 reason の OR 評価 (Codex Critical-4)", () => {
    it("1 件目 user 系、2 件目 scope_revoked → scope_revoked", () => {
      // errors[0] のみ参照すると見落とすため .some() で全件走査
      expect(
        classifyGmail403(
          makeGaxios(403, ["recipientRejected", "insufficientPermissions"]),
        ),
      ).toBe("scope_revoked");
    });

    it("2 件とも scope_revoked → scope_revoked", () => {
      expect(
        classifyGmail403(
          makeGaxios(403, ["delegationDenied", "userRateLimitExceeded"]),
        ),
      ).toBe("scope_revoked");
    });

    it("2 件とも user 系 → user_permanent", () => {
      expect(
        classifyGmail403(makeGaxios(403, ["recipientRejected", "forbidden"])),
      ).toBe("user_permanent");
    });
  });

  describe("HTTP 403 ガード (Codex Critical-5)", () => {
    it("status=429 → throw (transient と分類するのは呼び出し側の責務)", () => {
      expect(() =>
        classifyGmail403(makeGaxios(429, ["rateLimitExceeded"])),
      ).toThrow(/non-403/);
    });

    it("status=503 → throw", () => {
      expect(() => classifyGmail403(makeGaxios(503))).toThrow(/non-403/);
    });

    it("status=401 → throw (token 失効は別経路)", () => {
      expect(() => classifyGmail403(makeGaxios(401))).toThrow(/non-403/);
    });

    it("status=200 → throw (誤呼び出し検知)", () => {
      expect(() => classifyGmail403(makeGaxios(200))).toThrow(/non-403/);
    });

    it("response 不在 → throw (status=unknown)", () => {
      const err = new Error("plain error");
      expect(() => classifyGmail403(err)).toThrow(/non-403/);
    });

    it("response.status 不在 → throw", () => {
      const err = new Error("err") as Error & { response?: unknown };
      err.response = {};
      expect(() => classifyGmail403(err)).toThrow(/non-403/);
    });
  });

  describe("不正形式の入力 (defense in depth)", () => {
    it("non-Error 入力 (string) → throw", () => {
      expect(() => classifyGmail403("string error")).toThrow(/non-object/);
    });

    it("null → throw", () => {
      expect(() => classifyGmail403(null)).toThrow(/non-object/);
    });

    it("undefined → throw", () => {
      expect(() => classifyGmail403(undefined)).toThrow(/non-object/);
    });

    it("status=403 だが data 不在 → user_permanent (空 errors 扱い)", () => {
      const err = new Error("err") as Error & { response?: { status?: number } };
      err.response = { status: 403 };
      expect(classifyGmail403(err)).toBe("user_permanent");
    });
  });
});
