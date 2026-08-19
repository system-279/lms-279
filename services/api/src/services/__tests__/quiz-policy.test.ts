import { describe, it, expect } from "vitest";
import { resolveTenantQuizPolicy } from "../quiz-policy.js";
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
