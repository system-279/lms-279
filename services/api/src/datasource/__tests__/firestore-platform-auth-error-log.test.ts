/**
 * Issue #292: FirestoreDataSource.createPlatformAuthErrorLog の直接テスト
 *
 * 本番で動くのは Firestore 実装だが、既存の super-admin-auth-logging テストは
 * InMemory スタブで差し替えているため、root コレクション書き込みの単体検証がない。
 * 以下を直接検証することで本番回帰を防ぐ:
 *   - 書き込み先が `platform_auth_error_logs`（root コレクション）であること
 *   - `tenants/` プレフィックス配下に誤って書き込んでいないこと
 *   - `occurredAt` が Firestore Timestamp に変換されること
 *   - 入力値が body に保持されること（reason / firebaseErrorCode を含む）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../firestore.js";

function buildMockDb() {
  const setMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn().mockReturnValue({ id: "generated-id", set: setMock });
  const collectionMock = vi.fn().mockReturnValue({ doc: docMock });
  const db = { collection: collectionMock } as unknown as Firestore;
  return { db, setMock, docMock, collectionMock };
}

describe("FirestoreDataSource.createPlatformAuthErrorLog (Issue #292)", () => {
  let mock: ReturnType<typeof buildMockDb>;

  beforeEach(() => {
    mock = buildMockDb();
  });

  it("ルートコレクション `platform_auth_error_logs` に書き込む", async () => {
    const ds = new FirestoreDataSource(mock.db, "__platform__");
    await ds.createPlatformAuthErrorLog({
      email: "user@example.com",
      tenantId: "__platform__",
      errorType: "super_admin_denied",
      reason: "not_super_admin",
      errorMessage: "not registered",
      path: "/admin",
      method: "GET",
      userAgent: null,
      ipAddress: null,
      firebaseErrorCode: null,
      occurredAt: "2026-04-22T12:00:00.000Z",
    });

    expect(mock.collectionMock).toHaveBeenCalledTimes(1);
    expect(mock.collectionMock).toHaveBeenCalledWith("platform_auth_error_logs");
  });

  it("tenant スコープ配下（`tenants/*`）には書き込まない", async () => {
    const ds = new FirestoreDataSource(mock.db, "acme");
    await ds.createPlatformAuthErrorLog({
      email: "user@example.com",
      tenantId: "__platform__",
      errorType: "super_admin_denied",
      reason: "no_auth_header",
      errorMessage: "missing",
      path: "/admin",
      method: "GET",
      userAgent: null,
      ipAddress: null,
      firebaseErrorCode: null,
      occurredAt: "2026-04-22T12:00:00.000Z",
    });

    const collectionCalls = mock.collectionMock.mock.calls.map((c) => c[0] as string);
    expect(collectionCalls).toEqual(["platform_auth_error_logs"]);
    expect(collectionCalls.some((name) => name.startsWith("tenants/"))).toBe(false);
  });

  it("occurredAt を Firestore Timestamp に変換し、reason/firebaseErrorCode を保存する", async () => {
    const ds = new FirestoreDataSource(mock.db, "__platform__");
    await ds.createPlatformAuthErrorLog({
      email: "verify@example.com",
      tenantId: "__platform__",
      errorType: "super_admin_token_error",
      reason: null,
      errorMessage: "revoked",
      path: "/admin",
      method: "POST",
      userAgent: "curl",
      ipAddress: "10.0.0.1",
      firebaseErrorCode: "auth/id-token-revoked",
      occurredAt: "2026-04-22T12:00:00.000Z",
    });

    expect(mock.setMock).toHaveBeenCalledTimes(1);
    const saved = mock.setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.reason).toBeNull();
    expect(saved.firebaseErrorCode).toBe("auth/id-token-revoked");
    expect(saved.email).toBe("verify@example.com");
    expect(saved.occurredAt).toBeInstanceOf(Timestamp);
  });

  it("read-after-write せず、入力から直接復元した AuthErrorLog を返す（H-2対応）", async () => {
    const ds = new FirestoreDataSource(mock.db, "__platform__");
    const result = await ds.createPlatformAuthErrorLog({
      email: "x@example.com",
      tenantId: "__platform__",
      errorType: "super_admin_denied",
      reason: "not_super_admin",
      errorMessage: "msg",
      path: "/admin",
      method: "GET",
      userAgent: null,
      ipAddress: null,
      firebaseErrorCode: null,
      occurredAt: "2026-04-22T12:00:00.000Z",
    });

    expect(result.id).toBe("generated-id");
    expect(result.email).toBe("x@example.com");
    expect(result.reason).toBe("not_super_admin");
  });
});
