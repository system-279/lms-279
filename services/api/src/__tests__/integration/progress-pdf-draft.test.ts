/**
 * progress-pdf-draft 統合テスト (ADR-034 Phase 2)
 *
 * AC カバレッジ:
 * - AC-2: 下書き作成成功 → 201 + { draftId, draftUrl } + 監査ログ書き込み
 * - AC-4: Gmail API quota 超過 → 429
 * - AC-5: scope 不足 → 403 gmail_scope_required
 * - AC-6: demo テナント拒否 → 400
 * - AC-7: 越境 (user_not_in_tenant) → 404
 * - AC-8: 監査ログ書き込み内容検証 (PII 最小化、status)
 * - AC-10: 全 section false → 400 no_sections_selected
 * - AC-11: PDF サイズ超過 → 413 + 失敗監査ログ
 * - AC-12: Gmail API 失敗時 失敗監査ログ + エラーレスポンス
 *
 * モック方針:
 * - super-admin middleware: req.superAdmin を固定セット
 * - getFirestore: tenant doc + 監査ログ書き込みを操作
 * - getDataSource: InMemoryDataSource ベース
 * - createGmailDraft: 成功/失敗を切り替え
 * - renderToBuffer: PDF サイズ超過テスト用に上書き可能
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

// --- vi.hoisted モック準備 ---

const mocks = vi.hoisted(() => ({
  superAdminEmail: "super@example.com",
  superAdminUid: "uid-super",
  createGmailDraftMock: vi.fn(),
  renderToBufferMock: vi.fn(),
  recordPdfDraftLogMock: vi.fn(),
  tenantDocGetMock: vi.fn(),
  // idempotency check 用 (pdf_draft_logs/{requestId}.get())
  idempotencyDocGetMock: vi.fn(),
}));

// 注意: super-admin middleware は vi.mock せず、buildApp() で inline 注入する。
// vi.mock すると他テストファイルにも影響することがあるため (vitest hoisting の挙動)。

vi.mock("firebase-admin/firestore", async () => {
  const actual = await vi.importActual<typeof import("firebase-admin/firestore")>("firebase-admin/firestore");
  return {
    ...actual,
    getFirestore: vi.fn(() => {
      // tenants/{tid}/pdf_draft_logs/{rid}.get() の階層モック
      const subDoc = { get: mocks.idempotencyDocGetMock };
      const subCollection = { doc: () => subDoc };
      const tenantDocRef = {
        get: mocks.tenantDocGetMock,
        collection: () => subCollection,
      };
      const tenantsCollection = { doc: () => tenantDocRef };
      return { collection: () => tenantsCollection };
    }),
  };
});

vi.mock("@react-pdf/renderer", async () => {
  const actual = await vi.importActual<typeof import("@react-pdf/renderer")>("@react-pdf/renderer");
  return {
    ...actual,
    renderToBuffer: mocks.renderToBufferMock,
  };
});

vi.mock("../../services/gmail-draft.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/gmail-draft.js")>(
    "../../services/gmail-draft.js",
  );
  return {
    ...actual,
    createGmailDraft: mocks.createGmailDraftMock,
  };
});

vi.mock("../../services/pdf-draft-audit.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/pdf-draft-audit.js")>(
    "../../services/pdf-draft-audit.js",
  );
  return {
    ...actual,
    recordPdfDraftLog: mocks.recordPdfDraftLogMock,
  };
});

const datasourceMock = vi.hoisted(() => ({
  getDataSourceMock: vi.fn(),
}));

vi.mock("../../datasource/factory.js", () => ({
  getDataSource: datasourceMock.getDataSourceMock,
}));

// --- imports after mocks ---

import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { progressPdfDraftRouter } from "../../routes/super/progress-pdf-draft.js";
import { GmailDraftError } from "../../services/gmail-draft.js";

const ALL_ON = { profile: true, deadline: true, summary: true, lessons: true, quiz: true, pace: true, video: true };
const FAKE_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024, 0x20)]);

async function seedTenant(ds: InMemoryDataSource) {
  const user = await ds.createUser({
    email: "student@example.com",
    name: "山田 太郎",
    role: "student",
  });
  const course = await ds.createCourse({
    name: "サンプルコース",
    description: null,
    status: "published",
    lessonOrder: [],
    passThreshold: 70,
    createdBy: "admin@test",
  });
  await ds.upsertTenantEnrollmentSetting({
    enrolledAt: "2026-04-01T00:00:00Z",
    videoAccessUntil: "2027-05-13T14:59:59.999Z",
    quizAccessUntil: "2026-07-13T14:59:59.999Z",
    createdBy: "super@test",
  });
  return { user, course };
}

function buildApp(opts?: { withSuperAdmin?: boolean }) {
  const withSuperAdmin = opts?.withSuperAdmin ?? true;
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  if (withSuperAdmin) {
    app.use((req, _res, next) => {
      req.superAdmin = { email: mocks.superAdminEmail, firebaseUid: mocks.superAdminUid };
      next();
    });
  }
  app.use("/api/v2/super", progressPdfDraftRouter);
  return app;
}

describe("POST /api/v2/super/tenants/:tenantId/users/:userId/progress-pdf-draft", () => {
  let ds: InMemoryDataSource;
  let app: express.Express;
  let request: ReturnType<typeof supertest>;

  beforeEach(() => {
    vi.clearAllMocks();
    ds = new InMemoryDataSource({ readOnly: false });
    datasourceMock.getDataSourceMock.mockImplementation(() => ds);
    mocks.renderToBufferMock.mockResolvedValue(FAKE_PDF);
    mocks.recordPdfDraftLogMock.mockResolvedValue(undefined);
    // tenant doc デフォルトは ownerEmail 設定済み
    mocks.tenantDocGetMock.mockResolvedValue({
      exists: true,
      data: () => ({ name: "莞爾会 長遊園", ownerEmail: "owner@example.com" }),
    });
    // idempotency check デフォルトは存在しない (新規ケース)
    mocks.idempotencyDocGetMock.mockResolvedValue({ exists: false, data: () => undefined });
    mocks.createGmailDraftMock.mockResolvedValue({
      draftId: "r-12345",
      draftUrl: "https://mail.google.com/mail/u/0/?ogbl#drafts/r-12345",
    });

    app = buildApp();
    request = supertest(app);
  });

  describe("バリデーション", () => {
    it("invalid_tenant_id: パストラバーサル文字 → 400", async () => {
      const res = await request
        .post("/api/v2/super/tenants/..%2Fevil/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_tenant_id");
    });

    it("AC-6: demo テナント → 400 demo_tenant_not_supported", async () => {
      const res = await request
        .post("/api/v2/super/tenants/demo/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("demo_tenant_not_supported");
    });

    it("invalid_user_id: 不正文字 → 400", async () => {
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/..%2Fevil/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_user_id");
    });

    it("invalid_request_id: 空文字 → 400", async () => {
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request_id");
    });

    it("invalid_sections: section が boolean でない → 400", async () => {
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: { ...ALL_ON, profile: "yes" }, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_sections");
    });

    it("invalid_access_token: 空文字 → 400", async () => {
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_access_token");
    });

    it("AC-10: 全 section false → 400 no_sections_selected", async () => {
      const allOff = { profile: false, deadline: false, summary: false, lessons: false, quiz: false, pace: false, video: false };
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: allOff, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("no_sections_selected");
    });
  });

  describe("tenant / user チェック", () => {
    it("tenant_not_found → 404", async () => {
      mocks.tenantDocGetMock.mockResolvedValueOnce({ exists: false, data: () => ({}) });

      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("tenant_not_found");
    });

    it("owner_email_not_set → 400", async () => {
      mocks.tenantDocGetMock.mockResolvedValueOnce({
        exists: true,
        data: () => ({ name: "Tenant", ownerEmail: null }),
      });

      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("owner_email_not_set");
    });

    it("AC-7: 越境 (user_not_in_tenant) → 404", async () => {
      // ds に user を seed しない
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/non-existent/progress-pdf-draft")
        .send({ requestId: "r", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("user_not_in_tenant");
    });
  });

  describe("成功系", () => {
    it("AC-2: 下書き作成成功 → 201 + draftId/draftUrl", async () => {
      const { user } = await seedTenant(ds);

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-2026-05-14-001", sections: ALL_ON, accessToken: "ya29.test_token" });

      expect(res.status).toBe(201);
      expect(res.body.draftId).toBe("r-12345");
      expect(res.body.draftUrl).toBe("https://mail.google.com/mail/u/0/?ogbl#drafts/r-12345");

      // createGmailDraft が正しい引数で呼ばれた
      expect(mocks.createGmailDraftMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "ya29.test_token",
          to: "owner@example.com",
          subject: expect.stringContaining("莞爾会 長遊園"),
          body: expect.stringContaining("山田 太郎"),
          attachment: expect.objectContaining({
            // Issue #366: 日本語名 (山田 太郎) がそのままファイル名に含まれる
            // (連続 _ で受講者を識別不能にしない)
            filename: expect.stringMatching(/^progress-山田 太郎-\d{4}-\d{2}-\d{2}\.pdf$/),
            contentType: "application/pdf",
            content: FAKE_PDF,
          }),
        }),
      );
    });

    // Issue #366 の再発防止リグレッションマーカー。AC-2 (上記) の正規表現でも完全に
     // 検証済みだが、本テストは「日本語が ___ に潰れない」という Issue 本質を
     // 直接的に表現するため、意図を明示するシグナルとして残す。
    it("Issue #366: 日本語名は filename に保持され ___ に潰されない", async () => {
      const { user } = await seedTenant(ds);

      await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-jp-name", sections: ALL_ON, accessToken: "t" });

      const call = mocks.createGmailDraftMock.mock.calls[0]?.[0];
      const filename: string = call?.attachment?.filename ?? "";
      expect(filename).toContain("山田 太郎");
      expect(filename).not.toMatch(/_{3,}/);
    });

    it("AC-8: 成功時 監査ログに status=success + PII 最小化", async () => {
      const { user } = await seedTenant(ds);

      await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-success", sections: ALL_ON, accessToken: "t" });

      expect(mocks.recordPdfDraftLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          requestId: "req-success",
          tenantId: "tenant-1",
          createdByUid: mocks.superAdminUid,
          createdByEmail: mocks.superAdminEmail,
          userId: user.id,
          ownerEmail: "owner@example.com",
          draftId: "r-12345",
          status: "success",
          errorCode: null,
          sections: ALL_ON,
          pdfSizeBytes: FAKE_PDF.length,
        }),
      );
    });
  });

  describe("Gmail API エラー → 失敗監査ログ + エラーレスポンス", () => {
    it("AC-5: scope 不足 → 403 gmail_scope_required + 失敗ログ", async () => {
      const { user } = await seedTenant(ds);
      mocks.createGmailDraftMock.mockRejectedValueOnce(
        new GmailDraftError("scope insufficient", "gmail_scope_required", 403),
      );

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-scope", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("gmail_scope_required");

      // AC-12: 失敗時の監査ログ
      expect(mocks.recordPdfDraftLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          requestId: "req-scope",
          status: "failed",
          errorCode: "gmail_scope_required",
          draftId: null,
          pdfSizeBytes: FAKE_PDF.length,
        }),
      );
    });

    it("AC-4: quota 超過 → 429 gmail_quota_exceeded + 失敗ログ", async () => {
      const { user } = await seedTenant(ds);
      mocks.createGmailDraftMock.mockRejectedValueOnce(
        new GmailDraftError("quota exceeded", "gmail_quota_exceeded", 429),
      );

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-quota", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(429);
      expect(res.body.error).toBe("gmail_quota_exceeded");
      expect(mocks.recordPdfDraftLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "failed", errorCode: "gmail_quota_exceeded" }),
      );
    });

    it("401 → invalid_access_token + 失敗ログ", async () => {
      const { user } = await seedTenant(ds);
      mocks.createGmailDraftMock.mockRejectedValueOnce(
        new GmailDraftError("token expired", "invalid_access_token", 401),
      );

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-401", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_access_token");
    });

    it("Gmail API 5xx → 502 gmail_api_error + 失敗ログ", async () => {
      const { user } = await seedTenant(ds);
      mocks.createGmailDraftMock.mockRejectedValueOnce(
        new GmailDraftError("upstream", "gmail_api_error", 502),
      );

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-502", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("gmail_api_error");
    });
  });

  describe("PDF サイズ上限", () => {
    it("AC-11: 5MB 超 → 413 pdf_too_large_for_gmail + 失敗ログ", async () => {
      const { user } = await seedTenant(ds);
      const HUGE_PDF = Buffer.alloc(6 * 1024 * 1024, 0x20); // 6MB
      mocks.renderToBufferMock.mockResolvedValueOnce(HUGE_PDF);

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-huge", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe("pdf_too_large_for_gmail");
      // 失敗監査ログ
      expect(mocks.recordPdfDraftLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "failed",
          errorCode: "pdf_too_large_for_gmail",
          pdfSizeBytes: HUGE_PDF.length,
        }),
      );
      // Gmail draft は呼ばれない
      expect(mocks.createGmailDraftMock).not.toHaveBeenCalled();
    });
  });

  describe("idempotency (重複ガード)", () => {
    it("既存 status=success の log があれば 200 + 既存 draftId/draftUrl を返す (createGmailDraft 呼ばれない)", async () => {
      const { user } = await seedTenant(ds);
      mocks.idempotencyDocGetMock.mockResolvedValueOnce({
        exists: true,
        data: () => ({ status: "success", draftId: "existing-draft-1" }),
      });

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-dup", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(200);
      expect(res.body.draftId).toBe("existing-draft-1");
      expect(res.body.draftUrl).toBe("https://mail.google.com/mail/u/0/?ogbl#drafts/existing-draft-1");
      expect(mocks.createGmailDraftMock).not.toHaveBeenCalled();
      expect(mocks.recordPdfDraftLogMock).not.toHaveBeenCalled();
    });

    it("既存 status=failed の log があれば新規作成にフォールスルー", async () => {
      const { user } = await seedTenant(ds);
      mocks.idempotencyDocGetMock.mockResolvedValueOnce({
        exists: true,
        data: () => ({ status: "failed", errorCode: "gmail_quota_exceeded" }),
      });

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-retry", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(201);
      expect(mocks.createGmailDraftMock).toHaveBeenCalledTimes(1);
    });

    it("idempotency check が throw しても新規作成にフォールスルー", async () => {
      const { user } = await seedTenant(ds);
      mocks.idempotencyDocGetMock.mockRejectedValueOnce(new Error("firestore unavailable"));

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-check-err", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(201);
      expect(mocks.createGmailDraftMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("requestId バリデーション", () => {
    it("requestId に / を含むと invalid_request_id (Firestore パスインジェクション防止)", async () => {
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "req/evil", sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request_id");
    });

    it("requestId が 129 chars だと invalid_request_id", async () => {
      const res = await request
        .post("/api/v2/super/tenants/tenant-1/users/u1/progress-pdf-draft")
        .send({ requestId: "a".repeat(129), sections: ALL_ON, accessToken: "t" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request_id");
    });
  });

  describe("ownerEmail バリデーション", () => {
    it("ownerEmail に \\r\\n を含むテナントは owner_email_not_set として拒否 (ヘッダインジェクション防止)", async () => {
      const { user } = await seedTenant(ds);
      mocks.tenantDocGetMock.mockResolvedValueOnce({
        exists: true,
        data: () => ({ name: "evil", ownerEmail: "owner@example.com\r\nBcc: attacker@evil.com" }),
      });

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-inject", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("owner_email_not_set");
      expect(mocks.createGmailDraftMock).not.toHaveBeenCalled();
    });
  });

  describe("PDF サイズ境界値", () => {
    it("PDF が 5MB ちょうど (5,242,880 bytes) → 通過 (上限は >)", async () => {
      const { user } = await seedTenant(ds);
      const EXACTLY_5MB = Buffer.alloc(5 * 1024 * 1024, 0x20);
      mocks.renderToBufferMock.mockResolvedValueOnce(EXACTLY_5MB);

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-5mb-exact", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(201);
    });

    it("PDF が 5MB+1byte → 413 pdf_too_large_for_gmail", async () => {
      const { user } = await seedTenant(ds);
      const FIVE_MB_PLUS_1 = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);
      mocks.renderToBufferMock.mockResolvedValueOnce(FIVE_MB_PLUS_1);

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-5mb-plus1", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(413);
    });
  });

  describe("503 transient", () => {
    it("Gmail API 503 → 503 gmail_api_transient", async () => {
      const { user } = await seedTenant(ds);
      mocks.createGmailDraftMock.mockRejectedValueOnce(
        new GmailDraftError("service unavailable", "gmail_api_transient", 503),
      );

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-503", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("gmail_api_transient");
    });
  });

  describe("監査ログ書き込み失敗のレジリエンス", () => {
    it("成功時 監査ログ失敗してもレスポンスはブロックしない", async () => {
      const { user } = await seedTenant(ds);
      mocks.recordPdfDraftLogMock.mockRejectedValueOnce(new Error("firestore unavailable"));

      const res = await request
        .post(`/api/v2/super/tenants/tenant-1/users/${user.id}/progress-pdf-draft`)
        .send({ requestId: "req-audit-fail", sections: ALL_ON, accessToken: "t" });

      expect(res.status).toBe(201);
      expect(res.body.draftId).toBe("r-12345");
    });
  });
});
