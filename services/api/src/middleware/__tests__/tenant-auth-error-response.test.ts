/**
 * B-2: TenantAccessDeniedError のレスポンス文言一般化テスト
 * - ユーザー列挙を防ぐため、レスポンス message は固定の一般化文言
 * - logger.warn / auth_error_logs には詳細（email, tenantId, 原因メッセージ）を残す
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

import {
  TenantAccessDeniedError,
  handleTenantAccessDenied,
} from "../tenant-auth.js";

function buildReq(overrides: Partial<Request> = {}): Request {
  return {
    tenantContext: { tenantId: "test-tenant", isDemo: false },
    path: "/test",
    method: "GET",
    header: () => undefined,
    ip: "127.0.0.1",
    ...overrides,
  } as unknown as Request;
}

function buildRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { json, status, res: { status, json } as unknown as Response };
}

describe("handleTenantAccessDenied", () => {
  let createAuthErrorLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createAuthErrorLog = vi.fn().mockResolvedValue(undefined);
  });

  it("レスポンス message は固定の一般化文言（ユーザー列挙防止）", async () => {
    const err = new TenantAccessDeniedError(
      "このメールアドレス (leak@example.com) はテナント「leak-tenant」へのアクセスが許可されていません。",
      "leak@example.com",
      "leak-tenant"
    );
    const req = buildReq({ dataSource: { createAuthErrorLog } as never });
    const { res, status, json } = buildRes();

    await handleTenantAccessDenied(err, req, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: "tenant_access_denied",
      message: "アクセス権限がありません。管理者にお問い合わせください。",
    });
    // レスポンスに email / tenantId / 原因メッセージが漏れないこと
    const payload = json.mock.calls[0][0] as { message: string };
    expect(payload.message).not.toContain("leak@example.com");
    expect(payload.message).not.toContain("leak-tenant");
  });

  it("auth_error_logs には詳細（email / tenantId / errorMessage）が保存される", async () => {
    const err = new TenantAccessDeniedError(
      "このメールアドレス (user@example.com) はテナント「acme」へのアクセスが許可されていません。",
      "user@example.com",
      "acme"
    );
    const req = buildReq({ dataSource: { createAuthErrorLog } as never });
    const { res } = buildRes();

    await handleTenantAccessDenied(err, req, res);

    expect(createAuthErrorLog).toHaveBeenCalledTimes(1);
    const logged = createAuthErrorLog.mock.calls[0][0];
    expect(logged.email).toBe("user@example.com");
    expect(logged.tenantId).toBe("acme");
    expect(logged.errorType).toBe("tenant_access_denied");
    expect(logged.errorMessage).toContain("user@example.com");
  });

  it("auth_error_logs 保存が失敗してもレスポンスは返る", async () => {
    const err = new TenantAccessDeniedError("denied", "user@example.com", "acme");
    const failingDs = {
      createAuthErrorLog: vi.fn().mockRejectedValue(new Error("firestore down")),
    };
    const req = buildReq({ dataSource: failingDs as never });
    const { res, status } = buildRes();

    await handleTenantAccessDenied(err, req, res);

    expect(status).toHaveBeenCalledWith(403);
  });
});
