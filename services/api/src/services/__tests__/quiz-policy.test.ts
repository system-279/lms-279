import { describe, it, expect } from "vitest";
import { canDownloadPdfAfterQuizSkip, resolveTenantQuizPolicy } from "../quiz-policy.js";
import type { TenantQuizPolicy } from "../../types/entities.js";

describe("resolveTenantQuizPolicy", () => {
  it("未設定（null）のとき既定値（両方 false、updatedBy/updatedAt は null）を返す", () => {
    expect(resolveTenantQuizPolicy(null)).toEqual({
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: false,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it("値ありのときはそのまま透過する", () => {
    const policy: TenantQuizPolicy = {
      id: "_config",
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    expect(resolveTenantQuizPolicy(policy)).toEqual({
      quizSkipEnabled: true,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
  });

  it("quizSkipEnabled=false かつ pdfDownloadAllowedForSkipped=true の組み合わせもそのまま透過する（master OFF 時のサブ設定保持、設計判断5）", () => {
    const policy: TenantQuizPolicy = {
      id: "_config",
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    expect(resolveTenantQuizPolicy(policy)).toEqual({
      quizSkipEnabled: false,
      pdfDownloadAllowedForSkipped: true,
      updatedBy: "admin@example.com",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
  });
});

describe("canDownloadPdfAfterQuizSkip", () => {
  function policyWith(quizSkipEnabled: boolean, pdfDownloadAllowedForSkipped: boolean): TenantQuizPolicy {
    return {
      id: "_config",
      quizSkipEnabled,
      pdfDownloadAllowedForSkipped,
      updatedBy: "admin@example.com",
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
  }

  it("未設定（null）のとき false を返す", () => {
    expect(canDownloadPdfAfterQuizSkip(null)).toBe(false);
  });

  it("quizSkipEnabled=true かつ pdfDownloadAllowedForSkipped=true のとき true を返す", () => {
    expect(canDownloadPdfAfterQuizSkip(policyWith(true, true))).toBe(true);
  });

  it("quizSkipEnabled=false（master OFF）かつ pdfDownloadAllowedForSkipped=true（sub 設定は保持）のとき false を返す", () => {
    expect(canDownloadPdfAfterQuizSkip(policyWith(false, true))).toBe(false);
  });

  it("quizSkipEnabled=true かつ pdfDownloadAllowedForSkipped=false のとき false を返す", () => {
    expect(canDownloadPdfAfterQuizSkip(policyWith(true, false))).toBe(false);
  });
});
