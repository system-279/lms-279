/**
 * dispatch-403-classifier の単体テスト (TDD RED)。
 *
 * 設計仕様書 §6.4、Codex Important-4 (403 reason 分類) に対応。
 *
 * Gmail API 403 を 2 つに分類:
 * - scope_revoked (全体中断): insufficientPermissions / delegationDenied / sender disabled 系
 * - user_permanent (宛先固有): その他 (受講者の Gmail 受信拒否設定等)
 *
 * 観点:
 * - GaxiosError 形式の data.error.errors[0].reason を読み取る
 * - 既知の scope_revoked reasons: insufficientPermissions / delegationDenied / userRateLimitExceeded
 * - reason が未定義 / errors 配列空 / data 不在 → user_permanent (デフォルト宛先固有)
 * - 非 403 / 非 Error 入力 → user_permanent (安全側、宛先固有として扱う)
 */

import { describe, it, expect } from "vitest";
import { classifyGmail403 } from "../dispatch-403-classifier.js";

function makeGaxios403(reason: string | undefined) {
  const err = new Error("403 Forbidden") as Error & {
    response?: { data?: unknown; status?: number };
  };
  err.response = {
    status: 403,
    data: {
      error: {
        errors: reason ? [{ reason }] : [],
      },
    },
  };
  return err;
}

describe("classifyGmail403", () => {
  describe("scope_revoked (run 全体中断)", () => {
    it("insufficientPermissions → scope_revoked", () => {
      expect(classifyGmail403(makeGaxios403("insufficientPermissions"))).toBe(
        "scope_revoked",
      );
    });

    it("delegationDenied → scope_revoked", () => {
      expect(classifyGmail403(makeGaxios403("delegationDenied"))).toBe(
        "scope_revoked",
      );
    });

    it("userRateLimitExceeded → scope_revoked (sender disabled 系)", () => {
      expect(classifyGmail403(makeGaxios403("userRateLimitExceeded"))).toBe(
        "scope_revoked",
      );
    });

    it("forbidden → scope_revoked (DWD 認可未反映の典型)", () => {
      expect(classifyGmail403(makeGaxios403("forbidden"))).toBe("scope_revoked");
    });
  });

  describe("user_permanent (宛先固有)", () => {
    it("既知の宛先固有 reason → user_permanent", () => {
      expect(classifyGmail403(makeGaxios403("recipientRejected"))).toBe(
        "user_permanent",
      );
    });

    it("未知の reason → user_permanent (デフォルト安全側)", () => {
      expect(classifyGmail403(makeGaxios403("someUnknownReason"))).toBe(
        "user_permanent",
      );
    });

    it("reason undefined → user_permanent", () => {
      expect(classifyGmail403(makeGaxios403(undefined))).toBe("user_permanent");
    });
  });

  describe("不正形式の入力 (defense in depth)", () => {
    it("response 不在 → user_permanent", () => {
      const err = new Error("plain error");
      expect(classifyGmail403(err)).toBe("user_permanent");
    });

    it("response.data 不在 → user_permanent", () => {
      const err = new Error("err") as Error & { response?: { status?: number } };
      err.response = { status: 403 };
      expect(classifyGmail403(err)).toBe("user_permanent");
    });

    it("non-Error 入力 → user_permanent", () => {
      expect(classifyGmail403("string error")).toBe("user_permanent");
      expect(classifyGmail403(null)).toBe("user_permanent");
      expect(classifyGmail403(undefined)).toBe("user_permanent");
    });
  });
});
