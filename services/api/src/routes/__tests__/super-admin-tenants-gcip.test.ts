/**
 * PATCH /api/v2/super/tenants/:id の GCIP フィールド (gcipTenantId / useGcip)
 * バリデーションテスト + POST /api/v2/super/tenants 初期値テスト
 *
 * Issue #312 (ADR-031 Phase 3): Tenant スキーマ拡張
 *
 * 確認対象:
 *   - AC: PATCH で gcipTenantId: "" → 400 invalid_gcip_tenant_id
 *   - AC: PATCH で gcipTenantId: 数値 → 400 invalid_gcip_tenant_id
 *   - AC: PATCH で useGcip: 非 boolean → 400 invalid_use_gcip
 *   - AC: PATCH で useGcip: true + gcipTenantId: null → 400 gcip_tenant_id_required
 *   - AC: POST 新規作成時に gcipTenantId: null + useGcip: false が初期値
 *
 * スコープ外: PATCH 正常系の更新フロー（Firestore 更新後のレスポンス）は
 *             Firestore mock が広範になるため、Sub-Issue G (GCIP 自動化) で
 *             Identity Platform と合わせて統合検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockTransactionCreate = vi.fn();
const mockTransactionSet = vi.fn();
const mockRunTransaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
  await cb({ create: mockTransactionCreate, set: mockTransactionSet });
});
const mockTenantDocGet = vi.fn();
const mockSuperAdminsCollectionGet = vi.fn().mockResolvedValue({ docs: [] });
const mockGetUserByEmail = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    getUserByEmail: mockGetUserByEmail,
  }),
}));

vi.mock("firebase-admin/firestore", () => {
  // テナント配下のサブコレクション (allowed_emails / users) 用の簡易 doc
  const makeSubDoc = () => ({ id: "sub-doc-id" });
  const makeSubCollection = () => ({ doc: () => makeSubDoc() });
  const makeTenantDoc = (id?: string) => ({
    id: id ?? "generated-doc-id",
    get: mockTenantDocGet,
    update: vi.fn(),
    collection: () => makeSubCollection(),
  });
  const makeCollection = (path: string) => {
    if (path === "superAdmins") {
      return { get: mockSuperAdminsCollectionGet };
    }
    return {
      doc: (id?: string) => makeTenantDoc(id),
      where: () => ({
        count: () => ({ get: vi.fn().mockResolvedValue({ data: () => ({ count: 0 }) }) }),
      }),
    };
  };
  return {
    getFirestore: () => ({
      collection: (path: string) => makeCollection(path),
      runTransaction: mockRunTransaction,
    }),
  };
});

async function buildApp() {
  const { superAdminRouter } = await import("../super-admin.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v2/super", superAdminRouter);
  return app;
}

describe("PATCH /api/v2/super/tenants/:id — GCIP フィールドバリデーション (Issue #312)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "dev");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "super@example.com");
    mockTenantDocGet.mockReset();
    mockSuperAdminsCollectionGet.mockResolvedValue({ docs: [] });
    // デフォルト: tenant は存在、GCIP 未設定
    mockTenantDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        id: "tenant-a",
        name: "Tenant A",
        ownerId: "uid-1",
        ownerEmail: "owner@example.com",
        status: "active",
        gcipTenantId: null,
        useGcip: false,
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gcipTenantId に空文字を指定すると 400 invalid_gcip_tenant_id", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .patch("/api/v2/super/tenants/tenant-a")
      .set("X-User-Email", "super@example.com")
      .send({ gcipTenantId: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_gcip_tenant_id");
  });

  it("gcipTenantId に数値（非 string/非 null）を指定すると 400 invalid_gcip_tenant_id", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .patch("/api/v2/super/tenants/tenant-a")
      .set("X-User-Email", "super@example.com")
      .send({ gcipTenantId: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_gcip_tenant_id");
  });

  it("useGcip に非 boolean を指定すると 400 invalid_use_gcip", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .patch("/api/v2/super/tenants/tenant-a")
      .set("X-User-Email", "super@example.com")
      .send({ useGcip: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_use_gcip");
  });

  it("既存 gcipTenantId が null のテナントで useGcip: true のみ指定すると 400 gcip_tenant_id_required", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .patch("/api/v2/super/tenants/tenant-a")
      .set("X-User-Email", "super@example.com")
      .send({ useGcip: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("gcip_tenant_id_required");
  });
});

describe("POST /api/v2/super/tenants — GCIP 初期値 (Issue #312)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "dev");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "super@example.com");
    mockTransactionCreate.mockReset();
    mockTransactionSet.mockReset();
    mockRunTransaction.mockClear();
    mockSuperAdminsCollectionGet.mockResolvedValue({ docs: [] });
    // tenant ID 衝突チェックで非存在を返す
    mockTenantDocGet.mockResolvedValue({ exists: false });
    // オーナー UID 解決失敗 (未登録ユーザー)
    mockGetUserByEmail.mockRejectedValue(new Error("not found"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("新規テナント作成時に gcipTenantId: null + useGcip: false が transaction.create に渡される", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .post("/api/v2/super/tenants")
      .set("X-User-Email", "super@example.com")
      .send({ name: "New Tenant", ownerEmail: "new-owner@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.tenant.gcipTenantId).toBeNull();
    expect(res.body.tenant.useGcip).toBe(false);

    // transaction.create に渡された tenant メタデータを検証
    expect(mockTransactionCreate).toHaveBeenCalled();
    const tenantMetadata = mockTransactionCreate.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(tenantMetadata.gcipTenantId).toBeNull();
    expect(tenantMetadata.useGcip).toBe(false);
  });
});
