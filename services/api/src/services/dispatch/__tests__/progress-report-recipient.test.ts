/**
 * progress-report-recipient.ts の Integration テスト (Phase 3 PR 3c)。
 *
 * 設計仕様書 §4.1、AC-PR-06 / AC-PR-07 / AC-PR-08 / AC-PR-09 / AC-PR-17 対応。
 *
 * 観点:
 *   - tryClaimRecipientOrSkip 新規 → claimed=true、pending status で create
 *   - leaseExpiresAt = now + PROGRESS_REPORT_RECIPIENT_LEASE_MS (10min)
 *   - ttlExpireAt = now + PROGRESS_REPORT_RECIPIENT_TTL_DAYS (90 days) — AC-PR-17
 *   - 同 occurrenceId × userId で 2 回目 claim → reason="currently_pending_by_other_worker"
 *   - 別 occurrenceId × 同 userId → 別 doc として claim 成功 (AC-PR-08)
 *   - pending lease 切れ後の claim → manual_review 降格 + 失敗 (AC-PR-07)
 *   - sent 後の claim → reason="already_sent" (AC-PR-06 冪等)
 *   - failed 後の claim → reason="already_failed"
 *   - markRecipientSent: 三者一致 precondition / sent fields 反映
 *   - markRecipientFailed: 三者一致 precondition / error fields 反映
 *   - getRecipient: 不在で null、存在で fixture と一致
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";
import {
  getRecipient,
  markRecipientFailed,
  markRecipientSent,
  tryClaimRecipientOrSkip,
} from "../progress-report-recipient.js";

const NOW = new Date("2026-06-03T03:00:00.000Z");
const TENANT_ID = "t1";
const USER_ID = "u1";
const OCC_1 = "occ_1_sha256_hex";
const OCC_2 = "occ_2_sha256_hex";
const RUN_1 = "run-uuid-1";
const RUN_2 = "run-uuid-2";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let storage: InMemoryDispatchStorage;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
});

describe("tryClaimRecipientOrSkip — 新規 claim", () => {
  it("既存 doc なし → claimed=true, status=pending", async () => {
    const outcome = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    expect(outcome.claimed).toBe(true);

    const recipient = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    expect(recipient).not.toBeNull();
    expect(recipient!.status).toBe("pending");
    expect(recipient!.userId).toBe(USER_ID);
    expect(recipient!.runId).toBe(RUN_1);
    expect(recipient!.occurrenceId).toBe(OCC_1);
    expect(recipient!.claimedAt).toBe(NOW.toISOString());
  });

  it("leaseExpiresAt = now + PROGRESS_REPORT_RECIPIENT_LEASE_MS (10min)", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    const recipient = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    const expected = new Date(
      NOW.getTime() + DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_LEASE_MS,
    ).toISOString();
    expect(recipient!.leaseExpiresAt).toBe(expected);
  });

  it("ttlExpireAt = now + PROGRESS_REPORT_RECIPIENT_TTL_DAYS (90 days) — AC-PR-17", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    const recipient = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    const expected = new Date(
      NOW.getTime() +
        DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_TTL_DAYS * MS_PER_DAY,
    ).toISOString();
    expect(recipient!.ttlExpireAt).toBe(expected);
  });
});

describe("tryClaimRecipientOrSkip — 既存 doc あり (state 分岐)", () => {
  it("同 occurrenceId × userId pending → reason=currently_pending_by_other_worker", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    const second = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_2, // 別 runId でも同 occurrence で skip
      now: NOW,
    });
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toBe("currently_pending_by_other_worker");
    }
  });

  it("別 occurrenceId × 同 userId → 別 doc として claim 成功 (AC-PR-08)", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    // 1 週間後の別 occurrence (実運用では別週)
    const oneWeekLater = new Date(NOW.getTime() + 7 * MS_PER_DAY);
    const second = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_2,
      runId: RUN_2,
      now: oneWeekLater,
    });
    expect(second.claimed).toBe(true);

    // 両 doc 共存
    const r1 = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    const r2 = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_2,
    });
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.runId).toBe(RUN_2);
  });

  it("pending lease 切れ後の claim → manual_review 降格 + reason=pending_lease_expired_promoted_to_manual_review (AC-PR-07)", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    // lease 切れ後 (11min 後)
    const afterLease = new Date(
      NOW.getTime() +
        DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_LEASE_MS +
        60_000,
    );
    const second = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_2,
      now: afterLease,
    });
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toBe("pending_lease_expired_promoted_to_manual_review");
    }

    // 既存 doc の status が manual_review_required に降格されている
    const recipient = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    expect(recipient!.status).toBe("manual_review_required");
    expect(recipient!.promotedAt).toBe(afterLease.toISOString());
  });

  it("sent 後の claim → reason=already_sent (AC-PR-06 冪等)", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    await markRecipientSent(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      sentAt: NOW.toISOString(),
      messageId: "msg-1",
      pdfSizeBytes: 12345,
      recipientToHash: "to_hash",
      recipientCcHashes: ["cc_hash"],
    });

    const second = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_2,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toBe("already_sent");
    }
  });

  it("failed 後の claim → reason=already_failed", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    await markRecipientFailed(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      failedAt: NOW.toISOString(),
      errorCode: "gmail_permanent_400",
      errorMessage: "sanitized error",
    });

    const second = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_2,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toBe("already_failed");
    }
  });

  it("manual_review_required 後の claim → reason=already_manual_review_required", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    // 1 回目 lease 切れで自動降格
    const afterLease = new Date(
      NOW.getTime() +
        DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_LEASE_MS +
        60_000,
    );
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_2,
      now: afterLease,
    });
    // 2 回目 lease 切れ後の claim → already_manual_review_required
    const third = await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: "run-uuid-3",
      now: new Date(afterLease.getTime() + 60_000),
    });
    expect(third.claimed).toBe(false);
    if (!third.claimed) {
      expect(third.reason).toBe("already_manual_review_required");
    }
  });
});

describe("markRecipientSent — sent fields 反映 + 三者一致 precondition", () => {
  it("正常: claim 後の markSent で status=sent + messageId / pdfSizeBytes / hashes 保存", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    const sentAt = new Date(NOW.getTime() + 5000).toISOString();
    await markRecipientSent(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      sentAt,
      messageId: "msg-abc",
      pdfSizeBytes: 54321,
      recipientToHash: "to_sha256",
      recipientCcHashes: ["cc1_sha256", "cc2_sha256"],
    });

    const recipient = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    expect(recipient!.status).toBe("sent");
    expect(recipient!.sentAt).toBe(sentAt);
    expect(recipient!.messageId).toBe("msg-abc");
    expect(recipient!.pdfSizeBytes).toBe(54321);
    expect(recipient!.recipientToHash).toBe("to_sha256");
    expect(recipient!.recipientCcHashes).toEqual(["cc1_sha256", "cc2_sha256"]);
  });

  it("doc 不在で markSent → throw", async () => {
    await expect(
      markRecipientSent(storage, {
        tenantId: TENANT_ID,
        userId: USER_ID,
        occurrenceId: OCC_1,
        runId: RUN_1,
        sentAt: NOW.toISOString(),
        messageId: "msg-x",
        pdfSizeBytes: 100,
        recipientToHash: "h",
        recipientCcHashes: [],
      }),
    ).rejects.toThrow(/no recipient/);
  });

  it("runId 不一致 → throw (stale finalize 防止、Codex HIGH-2)", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    await expect(
      markRecipientSent(storage, {
        tenantId: TENANT_ID,
        userId: USER_ID,
        occurrenceId: OCC_1,
        runId: "run-uuid-X", // 違う runId
        sentAt: NOW.toISOString(),
        messageId: "msg-x",
        pdfSizeBytes: 100,
        recipientToHash: "h",
        recipientCcHashes: [],
      }),
    ).rejects.toThrow(/runId mismatch/);
  });

  it("status=sent の再 markSent → throw (idempotency より一貫性優先)", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    await markRecipientSent(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      sentAt: NOW.toISOString(),
      messageId: "msg-1",
      pdfSizeBytes: 100,
      recipientToHash: "h",
      recipientCcHashes: [],
    });
    await expect(
      markRecipientSent(storage, {
        tenantId: TENANT_ID,
        userId: USER_ID,
        occurrenceId: OCC_1,
        runId: RUN_1,
        sentAt: NOW.toISOString(),
        messageId: "msg-2",
        pdfSizeBytes: 100,
        recipientToHash: "h",
        recipientCcHashes: [],
      }),
    ).rejects.toThrow(/status must be "pending"/);
  });
});

describe("markRecipientFailed — error fields 反映 + 三者一致 precondition", () => {
  it("正常: claim 後の markFailed で status=failed + errorCode / errorMessage 保存", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    const failedAt = new Date(NOW.getTime() + 5000).toISOString();
    await markRecipientFailed(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      failedAt,
      errorCode: "gmail_permanent_400",
      errorMessage: "sanitized message [REDACTED]",
      recipientToHash: "to_h",
      recipientCcHashes: [],
    });

    const recipient = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    expect(recipient!.status).toBe("failed");
    expect(recipient!.failedAt).toBe(failedAt);
    expect(recipient!.errorCode).toBe("gmail_permanent_400");
    expect(recipient!.errorMessage).toBe("sanitized message [REDACTED]");
    expect(recipient!.recipientToHash).toBe("to_h");
  });

  it("occurrenceId 不一致 → throw", async () => {
    await tryClaimRecipientOrSkip(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: NOW,
    });
    await expect(
      markRecipientFailed(storage, {
        tenantId: TENANT_ID,
        userId: USER_ID,
        occurrenceId: OCC_2, // 違う occurrence
        runId: RUN_1,
        failedAt: NOW.toISOString(),
        errorCode: "e",
        errorMessage: "m",
      }),
      // occurrence が違う場合 doc id が異なるので "no recipient" になる
    ).rejects.toThrow(/no recipient/);
  });
});

describe("getRecipient", () => {
  it("不在で null", async () => {
    const result = await getRecipient(storage, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      occurrenceId: OCC_1,
    });
    expect(result).toBeNull();
  });
});
