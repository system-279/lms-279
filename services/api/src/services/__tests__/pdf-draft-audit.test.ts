/**
 * pdf-draft-audit の単体テスト。
 *
 * 観点:
 * - hashEmail: 正規化 (trim+lowercase) 後の sha256
 * - recordPdfDraftLog: Firestore モックへの書き込み引数検証
 * - PII 最小化: createdByEmail / toEmail / ownerEmail が raw で保存されないこと
 * - 案 B (Issue #433) dual-write: ownerEmailHash + recipientToHash + recipientCcHash
 * - status=failed のとき errorCode 必須
 * - ttlAt が 90 日後相当の Timestamp
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashEmail, recordPdfDraftLog, __internal } from "../pdf-draft-audit.js";

const ALL_SECTIONS = {
  profile: true,
  deadline: true,
  summary: true,
  lessons: true,
  quiz: true,
  pace: true,
  video: true,
};

describe("hashEmail", () => {
  it("trim + lowercase してから sha256 でハッシュ化", () => {
    const h1 = hashEmail("User@Example.COM");
    const h2 = hashEmail("  user@example.com  ");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // sha256 hex
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });

  it("異なるメールは異なるハッシュ", () => {
    expect(hashEmail("a@example.com")).not.toBe(hashEmail("b@example.com"));
  });
});

describe("recordPdfDraftLog", () => {
  let setMock: ReturnType<typeof vi.fn>;
  let docMock: ReturnType<typeof vi.fn>;
  let collectionMock: ReturnType<typeof vi.fn>;
  let dbMock: { collection: typeof collectionMock };

  beforeEach(() => {
    setMock = vi.fn().mockResolvedValue(undefined);
    docMock = vi.fn(() => ({ set: setMock, collection: collectionMock }));
    collectionMock = vi.fn(() => ({ doc: docMock }));
    dbMock = { collection: collectionMock };
  });

  it("成功ログ: tenants/{id}/pdf_draft_logs/{requestId} に書き込まれる", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-001",
      tenantId: "tenant-1",
      createdByUid: "uid-super",
      createdByEmail: "super@example.com",
      userId: "user-1",
      toEmail: "student@example.com",
      ownerEmail: "owner@example.com",
      draftId: "draft-xyz",
      status: "success",
      errorCode: null,
      sections: ALL_SECTIONS,
      pdfSizeBytes: 102400,
    });

    expect(collectionMock).toHaveBeenNthCalledWith(1, "tenants");
    expect(docMock).toHaveBeenNthCalledWith(1, "tenant-1");
    expect(collectionMock).toHaveBeenNthCalledWith(2, "pdf_draft_logs");
    expect(docMock).toHaveBeenNthCalledWith(2, "req-001");

    const writeArg = setMock.mock.calls[0][0];
    expect(writeArg.createdByUid).toBe("uid-super");
    expect(writeArg.userId).toBe("user-1");
    expect(writeArg.draftId).toBe("draft-xyz");
    expect(writeArg.status).toBe("success");
    expect(writeArg.errorCode).toBe(null);
    expect(writeArg.pdfSizeBytes).toBe(102400);
  });

  it("createdByEmail / toEmail / ownerEmail が hash 化されて raw 文字列が保存されない", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-002",
      tenantId: "tenant-1",
      createdByUid: "uid-super",
      createdByEmail: "super@example.com",
      userId: "user-1",
      toEmail: "student@example.com",
      ownerEmail: "owner@example.com",
      draftId: "draft-xyz",
      status: "success",
      errorCode: null,
      sections: { profile: true, deadline: false, summary: false, lessons: false, quiz: false, pace: false, video: false },
      pdfSizeBytes: 1024,
    });

    const writeArg = setMock.mock.calls[0][0];
    expect(writeArg.createdByEmailHash).toBe(hashEmail("super@example.com"));
    expect(writeArg.recipientToHash).toBe(hashEmail("student@example.com"));
    expect(writeArg.recipientCcHash).toBe(hashEmail("owner@example.com"));
    // 後方互換 (案 B 移行後は recipientCcHash と同値)
    expect(writeArg.ownerEmailHash).toBe(hashEmail("owner@example.com"));
    // raw が保存されていないこと (AC-14)
    expect(JSON.stringify(writeArg)).not.toContain("super@example.com");
    expect(JSON.stringify(writeArg)).not.toContain("student@example.com");
    expect(JSON.stringify(writeArg)).not.toContain("owner@example.com");
  });

  it("AC-6/AC-14: dual-write スキーマ - 新規 recipientToHash + recipientCcHash と旧 ownerEmailHash が併存する", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-dual",
      tenantId: "tenant-1",
      createdByUid: "uid",
      createdByEmail: "super@example.com",
      userId: "user-1",
      toEmail: "student@example.com",
      ownerEmail: "owner@example.com",
      draftId: "draft-1",
      status: "success",
      errorCode: null,
      sections: ALL_SECTIONS,
      pdfSizeBytes: 1024,
    });

    const writeArg = setMock.mock.calls[0][0];
    // 新規フィールド (案 B)
    expect(writeArg).toHaveProperty("recipientToHash");
    expect(writeArg).toHaveProperty("recipientCcHash");
    // 後方互換フィールド (deprecated だが残置)
    expect(writeArg).toHaveProperty("ownerEmailHash");
  });

  it("AC-11: ownerEmail が null のときは recipientCcHash=null + ownerEmailHash=null (CC 省略時の dual-write)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-003",
      tenantId: "tenant-1",
      createdByUid: "uid",
      createdByEmail: "super@example.com",
      userId: "user-1",
      toEmail: "student@example.com",
      ownerEmail: null,
      draftId: "draft-1",
      status: "success",
      errorCode: null,
      sections: ALL_SECTIONS,
      pdfSizeBytes: 1024,
    });

    const writeArg = setMock.mock.calls[0][0];
    expect(writeArg.recipientToHash).toBe(hashEmail("student@example.com"));
    expect(writeArg.recipientCcHash).toBe(null);
    expect(writeArg.ownerEmailHash).toBe(null);
  });

  it("toEmail が null (PDF 生成前の失敗等) のときは recipientToHash=null で記録される", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-null-to",
      tenantId: "tenant-1",
      createdByUid: "uid",
      createdByEmail: "super@example.com",
      userId: "user-1",
      toEmail: null,
      ownerEmail: null,
      draftId: null,
      status: "failed",
      errorCode: "user_email_not_configured",
      sections: ALL_SECTIONS,
      pdfSizeBytes: null,
    });

    const writeArg = setMock.mock.calls[0][0];
    expect(writeArg.recipientToHash).toBe(null);
    expect(writeArg.recipientCcHash).toBe(null);
    expect(writeArg.status).toBe("failed");
    expect(writeArg.errorCode).toBe("user_email_not_configured");
  });

  it("ttlAt が 90 日後相当の Timestamp", async () => {
    const before = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-004",
      tenantId: "tenant-1",
      createdByUid: "uid",
      createdByEmail: "super@example.com",
      userId: "user-1",
      toEmail: "student@example.com",
      ownerEmail: "owner@example.com",
      draftId: "draft-1",
      status: "success",
      errorCode: null,
      sections: ALL_SECTIONS,
      pdfSizeBytes: 1024,
    });
    const after = Date.now();

    const writeArg = setMock.mock.calls[0][0];
    const ttlMillis = writeArg.ttlAt.toMillis() as number;
    const expectedMin = before + __internal.TTL_DAYS * 86400 * 1000;
    const expectedMax = after + __internal.TTL_DAYS * 86400 * 1000;
    expect(ttlMillis).toBeGreaterThanOrEqual(expectedMin);
    expect(ttlMillis).toBeLessThanOrEqual(expectedMax);
  });

  it("Firestore 書き込みエラーは throw する", async () => {
    setMock.mockRejectedValueOnce(new Error("firestore unavailable"));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recordPdfDraftLog(dbMock as any, {
        requestId: "req-005",
        tenantId: "tenant-1",
        createdByUid: "uid",
        createdByEmail: "super@example.com",
        userId: "user-1",
        toEmail: "student@example.com",
        ownerEmail: "owner@example.com",
        draftId: "draft-1",
        status: "success",
        errorCode: null,
        sections: ALL_SECTIONS,
        pdfSizeBytes: 1024,
      }),
    ).rejects.toThrow("firestore unavailable");
  });
});
