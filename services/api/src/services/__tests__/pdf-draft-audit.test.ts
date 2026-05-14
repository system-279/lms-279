/**
 * pdf-draft-audit の単体テスト。
 *
 * 観点:
 * - hashEmail: 正規化 (trim+lowercase) 後の sha256
 * - recordPdfDraftLog: Firestore モックへの書き込み引数検証
 * - PII 最小化: createdByEmail / ownerEmail が raw で保存されないこと
 * - status=failed のとき errorCode 必須
 * - ttlAt が 90 日後相当の Timestamp
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashEmail, recordPdfDraftLog, __internal } from "../pdf-draft-audit.js";

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
      ownerEmail: "owner@example.com",
      draftId: "draft-xyz",
      status: "success",
      errorCode: null,
      sections: { profile: true, deadline: true, summary: true, lessons: true, quiz: true, pace: true, video: true },
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

  it("createdByEmail / ownerEmail が hash 化されて raw 文字列が保存されない", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-002",
      tenantId: "tenant-1",
      createdByUid: "uid-super",
      createdByEmail: "super@example.com",
      userId: "user-1",
      ownerEmail: "owner@example.com",
      draftId: "draft-xyz",
      status: "success",
      errorCode: null,
      sections: { profile: true, deadline: false, summary: false, lessons: false, quiz: false, pace: false, video: false },
      pdfSizeBytes: 1024,
    });

    const writeArg = setMock.mock.calls[0][0];
    expect(writeArg.createdByEmailHash).toBe(hashEmail("super@example.com"));
    expect(writeArg.ownerEmailHash).toBe(hashEmail("owner@example.com"));
    // raw が保存されていないこと
    expect(JSON.stringify(writeArg)).not.toContain("super@example.com");
    expect(JSON.stringify(writeArg)).not.toContain("owner@example.com");
  });

  it("ownerEmail が null のときも ownerEmailHash=null で記録される", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordPdfDraftLog(dbMock as any, {
      requestId: "req-003",
      tenantId: "tenant-1",
      createdByUid: "uid",
      createdByEmail: "super@example.com",
      userId: "user-1",
      ownerEmail: null,
      draftId: null,
      status: "failed",
      errorCode: "owner_email_not_set",
      sections: { profile: true, deadline: true, summary: true, lessons: true, quiz: true, pace: true, video: true },
      pdfSizeBytes: null,
    });

    const writeArg = setMock.mock.calls[0][0];
    expect(writeArg.ownerEmailHash).toBe(null);
    expect(writeArg.status).toBe("failed");
    expect(writeArg.errorCode).toBe("owner_email_not_set");
    expect(writeArg.draftId).toBe(null);
    expect(writeArg.pdfSizeBytes).toBe(null);
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
      ownerEmail: "owner@example.com",
      draftId: "draft-1",
      status: "success",
      errorCode: null,
      sections: { profile: true, deadline: true, summary: true, lessons: true, quiz: true, pace: true, video: true },
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
        ownerEmail: "owner@example.com",
        draftId: "draft-1",
        status: "success",
        errorCode: null,
        sections: { profile: true, deadline: true, summary: true, lessons: true, quiz: true, pace: true, video: true },
        pdfSizeBytes: 1024,
      }),
    ).rejects.toThrow("firestore unavailable");
  });
});
