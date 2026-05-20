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
import {
  acquirePendingPdfDraftLog,
  finalizePdfDraftLog,
  hashEmail,
  recordPdfDraftLog,
  __internal,
} from "../pdf-draft-audit.js";

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

  // Issue #436: access token の発行元 Google アカウント email を sha256 で記録する。
  describe("AC-3 (Issue #436): tokenOwnerHash", () => {
    it("tokenOwnerEmail を渡すと sha256 で hash 化されて tokenOwnerHash として保存される", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordPdfDraftLog(dbMock as any, {
        requestId: "req-owner-hash",
        tenantId: "tenant-1",
        createdByUid: "uid",
        createdByEmail: "super@example.com",
        userId: "user-1",
        toEmail: "student@example.com",
        ownerEmail: null,
        tokenOwnerEmail: "super@example.com",
        draftId: "draft-1",
        status: "success",
        errorCode: null,
        sections: ALL_SECTIONS,
        pdfSizeBytes: 1024,
      });

      const writeArg = setMock.mock.calls[0][0];
      expect(writeArg.tokenOwnerHash).toBe(hashEmail("super@example.com"));
      // raw email は保存されない
      expect(JSON.stringify(writeArg)).not.toContain("super@example.com");
    });

    it("tokenOwnerEmail 未指定なら tokenOwnerHash=null", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordPdfDraftLog(dbMock as any, {
        requestId: "req-owner-null",
        tenantId: "tenant-1",
        createdByUid: "uid",
        createdByEmail: "super@example.com",
        userId: "user-1",
        toEmail: null,
        ownerEmail: null,
        // tokenOwnerEmail を省略
        draftId: null,
        status: "failed",
        errorCode: "gmail_api_transient",
        sections: ALL_SECTIONS,
        pdfSizeBytes: null,
      });

      const writeArg = setMock.mock.calls[0][0];
      expect(writeArg.tokenOwnerHash).toBe(null);
    });

    it("不一致時 (token owner と createdByEmail が異なる) でも tokenOwnerHash には実際の owner が記録される", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordPdfDraftLog(dbMock as any, {
        requestId: "req-mismatch",
        tenantId: "tenant-1",
        createdByUid: "uid",
        createdByEmail: "super@example.com",
        userId: "user-1",
        toEmail: null,
        ownerEmail: null,
        tokenOwnerEmail: "attacker@example.com",
        draftId: null,
        status: "failed",
        errorCode: "access_token_owner_mismatch",
        sections: ALL_SECTIONS,
        pdfSizeBytes: null,
      });

      const writeArg = setMock.mock.calls[0][0];
      expect(writeArg.tokenOwnerHash).toBe(hashEmail("attacker@example.com"));
      expect(writeArg.createdByEmailHash).toBe(hashEmail("super@example.com"));
      // 異なる hash になっていることで監査側で不一致が検出可能
      expect(writeArg.tokenOwnerHash).not.toBe(writeArg.createdByEmailHash);
    });
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

// Issue #435: pending 取得 (アトミック化) と finalize (状態遷移) の単体テスト
describe("acquirePendingPdfDraftLog (Issue #435)", () => {
  let createMock: ReturnType<typeof vi.fn>;
  let getMock: ReturnType<typeof vi.fn>;
  let docMock: ReturnType<typeof vi.fn>;
  let collectionMock: ReturnType<typeof vi.fn>;
  let dbMock: { collection: typeof collectionMock };

  beforeEach(() => {
    createMock = vi.fn();
    getMock = vi.fn();
    docMock = vi.fn(() => ({ create: createMock, get: getMock, collection: collectionMock }));
    collectionMock = vi.fn(() => ({ doc: docMock }));
    dbMock = { collection: collectionMock };
  });

  const baseInput = {
    requestId: "req-acquire",
    tenantId: "tenant-1",
    createdByUid: "uid-super",
    createdByEmail: "super@example.com",
    userId: "user-1",
    toEmail: "student@example.com",
    ownerEmail: "owner@example.com",
    tokenOwnerEmail: "super@example.com",
    sections: ALL_SECTIONS,
  };

  it("AC-1: doc 不存在 → docRef.create() で pending を書き込み acquired=true を返す", async () => {
    createMock.mockResolvedValueOnce(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await acquirePendingPdfDraftLog(dbMock as any, baseInput);

    expect(result).toEqual({ acquired: true });
    expect(createMock).toHaveBeenCalledTimes(1);
    const createArg = createMock.mock.calls[0][0];
    expect(createArg.status).toBe("pending");
    expect(createArg.draftId).toBe(null);
    expect(createArg.createdByUid).toBe("uid-super");
    expect(createArg.recipientToHash).toBe(hashEmail("student@example.com"));
    expect(createArg.tokenOwnerHash).toBe(hashEmail("super@example.com"));
    // PII 最小化 (raw email は保存されない)
    expect(JSON.stringify(createArg)).not.toContain("super@example.com");
    expect(JSON.stringify(createArg)).not.toContain("student@example.com");
  });

  it("AC-1: ALREADY_EXISTS (gRPC code 6) → 既存 doc を get して { acquired: false, existing } を返す (Gmail draft を二重作成しない)", async () => {
    const conflictErr = Object.assign(new Error("Document already exists"), { code: 6 });
    createMock.mockRejectedValueOnce(conflictErr);
    getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ status: "pending", draftId: null }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await acquirePendingPdfDraftLog(dbMock as any, baseInput);

    expect(result).toEqual({
      acquired: false,
      existing: { status: "pending", draftId: null },
    });
    // pending status の重複は二重作成防止
    if (!result.acquired) {
      expect(result.existing.status).toBe("pending");
    }
  });

  it("ALREADY_EXISTS で既存 status=success の場合は呼び出し側が分岐する (existing.status=success を返す)", async () => {
    const conflictErr = Object.assign(new Error("Document already exists"), { code: 6 });
    createMock.mockRejectedValueOnce(conflictErr);
    getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ status: "success", draftId: "draft-existing" }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await acquirePendingPdfDraftLog(dbMock as any, baseInput);

    if (result.acquired) throw new Error("expected acquired=false");
    expect(result.existing.status).toBe("success");
    expect(result.existing.draftId).toBe("draft-existing");
  });

  it("AC-3: ALREADY_EXISTS 以外の Firestore エラー → throw (route 層で 503)", async () => {
    const otherErr = Object.assign(new Error("DEADLINE_EXCEEDED"), { code: 4 });
    createMock.mockRejectedValueOnce(otherErr);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(acquirePendingPdfDraftLog(dbMock as any, baseInput)).rejects.toThrow(
      "DEADLINE_EXCEEDED",
    );
    // get は呼ばれない (ALREADY_EXISTS 経路ではないため)
    expect(getMock).not.toHaveBeenCalled();
  });

  it("ALREADY_EXISTS で get が exists=false (TOCTOU 競合の極端ケース) → throw", async () => {
    const conflictErr = Object.assign(new Error("Document already exists"), { code: 6 });
    createMock.mockRejectedValueOnce(conflictErr);
    getMock.mockResolvedValueOnce({ exists: false, data: () => undefined });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(acquirePendingPdfDraftLog(dbMock as any, baseInput)).rejects.toBeDefined();
  });
});

describe("finalizePdfDraftLog (Issue #435)", () => {
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

  it("AC-5: pending → success に draftId/status/errorCode/pdfSizeBytes/finalizedAt をマージ更新する", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await finalizePdfDraftLog(dbMock as any, {
      requestId: "req-final",
      tenantId: "tenant-1",
      draftId: "draft-1",
      status: "success",
      errorCode: null,
      pdfSizeBytes: 102400,
    });

    expect(setMock).toHaveBeenCalledTimes(1);
    const [docArg, opts] = setMock.mock.calls[0];
    expect(opts).toEqual({ merge: true });
    expect(docArg.draftId).toBe("draft-1");
    expect(docArg.status).toBe("success");
    expect(docArg.errorCode).toBe(null);
    expect(docArg.pdfSizeBytes).toBe(102400);
    expect(typeof docArg.finalizedAt).toBe("string");
    // pending 段階で書き込んだ他フィールド (createdByUid 等) を merge: true で保持
    expect(docArg).not.toHaveProperty("createdByUid");
  });

  it("AC-5: pending → failed の場合は errorCode が記録される", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await finalizePdfDraftLog(dbMock as any, {
      requestId: "req-fail-final",
      tenantId: "tenant-1",
      draftId: null,
      status: "failed",
      errorCode: "gmail_quota_exceeded",
      pdfSizeBytes: 5120,
    });

    const docArg = setMock.mock.calls[0][0];
    expect(docArg.status).toBe("failed");
    expect(docArg.errorCode).toBe("gmail_quota_exceeded");
    expect(docArg.draftId).toBe(null);
  });

  it("Firestore 書き込み失敗は throw する", async () => {
    setMock.mockRejectedValueOnce(new Error("firestore unavailable"));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalizePdfDraftLog(dbMock as any, {
        requestId: "req-err",
        tenantId: "tenant-1",
        draftId: "draft-1",
        status: "success",
        errorCode: null,
        pdfSizeBytes: 1024,
      }),
    ).rejects.toThrow("firestore unavailable");
  });
});
