/**
 * reservation の Integration テスト (InMemoryDispatchStorage 中心、ADR-028 準拠)。
 *
 * 設計仕様書 §6.2、FR-7 改訂、AC-10/11/12、Phase 2 完了条件:
 *   - Integration Test で transaction 競合 6 シナリオ網羅
 *     (新規 / sent / failed_permanent / reserved-in-lease / reserved-expired / manual_review)
 *
 * 観点:
 *   - 新規予約: completion_notifications 不在 → reserved=true で create
 *   - 既存 sent: → reserved=false, reason="already_sent"
 *   - 既存 failed_permanent: → reserved=false, reason="failed_permanent"
 *   - 既存 manual_review_required: → reserved=false, reason="manual_review_required"
 *   - 既存 reserved (lease 内): → reserved=false, reason="currently_reserved_by_other_run"
 *   - 既存 reserved (lease 期限切れ): → 降格 + reserved=false, reason="lease_expired_promoted_to_manual_review"
 *   - leaseExpiresAt = now + RESERVATION_LEASE_MS (10 分) で計算される
 *   - markSent: reserved → sent 遷移、snapshot/messageId/PII hash がセットされる
 *   - markFailedPermanent: reserved → failed_permanent 遷移、error code/message がセットされる
 *   - markSent: 予約なし / reserved 以外で呼ぶと throw (caller の前提違反検出)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";
import {
  tryReserveOrSkip,
  markSent,
  markFailedPermanent,
  getReservation,
} from "../reservation.js";

const TENANT = "tenant-A";
const USER = "user-1";
const RUN_ID = "run-uuid-1";
const NOW = new Date("2026-05-22T00:00:00.000Z");

let storage: InMemoryDispatchStorage;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
});

/** 既存予約を「sent」状態でセットアップ (markSent 経由で reserved → sent 遷移) */
async function seedSentReservation() {
  await tryReserveOrSkip(storage, {
    tenantId: TENANT,
    userId: USER,
    runId: RUN_ID,
    now: NOW,
  });
  await markSent(storage, {
    tenantId: TENANT,
    userId: USER,
    messageId: "msg-001",
    notifiedAt: NOW.toISOString(),
    courseIdsSnapshot: ["c1"],
    progressSnapshot: {
      completedLessons: 3,
      totalLessons: 3,
      coursesCompleted: 1,
      coursesTotal: 1,
    },
    recipientToHash: "hash-to",
    recipientCcHashes: ["hash-cc"],
    pdfSizeBytes: null,
  });
}

async function seedFailedPermanent() {
  await tryReserveOrSkip(storage, {
    tenantId: TENANT,
    userId: USER,
    runId: RUN_ID,
    now: NOW,
  });
  await markFailedPermanent(storage, {
    tenantId: TENANT,
    userId: USER,
    failedAt: NOW.toISOString(),
    errorCode: "gmail_api_error",
    errorMessage: "permanent failure",
  });
}

/** 既存予約を manual_review_required に直接遷移させる (lease 期限切れ経路) */
async function seedManualReview() {
  // 一旦 reserved にしておき、その後 lease 切れの 2 回目試行で降格させる
  await tryReserveOrSkip(storage, {
    tenantId: TENANT,
    userId: USER,
    runId: RUN_ID,
    now: NOW,
  });
  const expiredNow = new Date(
    NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS + 1000,
  );
  await tryReserveOrSkip(storage, {
    tenantId: TENANT,
    userId: USER,
    runId: "another-run",
    now: expiredNow,
  });
}

describe("tryReserveOrSkip (6 シナリオ網羅、Phase 2 完了条件)", () => {
  describe("シナリオ 1: 新規予約", () => {
    it("completion_notifications 不在 → reserved=true で create", async () => {
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: RUN_ID,
        now: NOW,
      });
      expect(result).toEqual({ reserved: true });

      const record = await getReservation(storage, TENANT, USER);
      expect(record).not.toBeNull();
      expect(record?.status).toBe("reserved");
      expect(record?.runId).toBe(RUN_ID);
      expect(record?.reservedAt).toBe(NOW.toISOString());
      // leaseExpiresAt = now + 10 分 (RESERVATION_LEASE_MS)
      const expectedLease = new Date(
        NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS,
      ).toISOString();
      expect(record?.leaseExpiresAt).toBe(expectedLease);
    });
  });

  describe("シナリオ 2: 既存 sent", () => {
    it("status=sent なら reserved=false, reason=already_sent", async () => {
      await seedSentReservation();
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "new-run",
        now: NOW,
      });
      expect(result).toEqual({ reserved: false, reason: "already_sent" });
    });

    it("sent 後の record は status / messageId が保持される (state 改変なし)", async () => {
      await seedSentReservation();
      await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "new-run",
        now: NOW,
      });
      const record = await getReservation(storage, TENANT, USER);
      expect(record?.status).toBe("sent");
      expect(record?.messageId).toBe("msg-001");
    });
  });

  describe("シナリオ 3: 既存 failed_permanent", () => {
    it("status=failed_permanent なら reserved=false, reason=failed_permanent", async () => {
      await seedFailedPermanent();
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "new-run",
        now: NOW,
      });
      expect(result).toEqual({ reserved: false, reason: "failed_permanent" });
    });
  });

  describe("シナリオ 4: 既存 manual_review_required", () => {
    it("status=manual_review_required なら reserved=false, reason=manual_review_required", async () => {
      await seedManualReview();
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "new-run",
        now: new Date(
          NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS * 10,
        ),
      });
      expect(result).toEqual({
        reserved: false,
        reason: "manual_review_required",
      });
    });
  });

  describe("シナリオ 5: 既存 reserved (lease 期限内、他 run が処理中)", () => {
    it("→ reserved=false, reason=currently_reserved_by_other_run", async () => {
      // run-1 が予約取得
      await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-1",
        now: NOW,
      });
      // run-2 が直後 (lease 内) に予約試行
      const slightlyLater = new Date(NOW.getTime() + 60_000); // 1 分後 < 10 分
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-2",
        now: slightlyLater,
      });
      expect(result).toEqual({
        reserved: false,
        reason: "currently_reserved_by_other_run",
      });
      // record は run-1 の予約を保持
      const record = await getReservation(storage, TENANT, USER);
      expect(record?.runId).toBe("run-1");
      expect(record?.status).toBe("reserved");
    });
  });

  describe("シナリオ 6: 既存 reserved (lease 期限切れ → manual_review 降格)", () => {
    it("→ reserved=false, reason=lease_expired_promoted_to_manual_review、record 状態が manual_review_required に降格", async () => {
      // run-1 が予約取得
      await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-1",
        now: NOW,
      });
      // lease 期限を 1 秒超過した時点で別 run が試行
      const expired = new Date(
        NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS + 1000,
      );
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-2",
        now: expired,
      });
      expect(result).toEqual({
        reserved: false,
        reason: "lease_expired_promoted_to_manual_review",
      });
      const record = await getReservation(storage, TENANT, USER);
      expect(record?.status).toBe("manual_review_required");
      expect(record?.failedAt).toBe(expired.toISOString());
    });

    it("降格後の再 reserve 試行は manual_review_required で skip (再送防止)", async () => {
      await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-1",
        now: NOW,
      });
      const expired = new Date(
        NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS + 1000,
      );
      await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-2",
        now: expired,
      });
      // run-3 が更に後で試行 (manual_review_required 検出)
      const muchLater = new Date(expired.getTime() + 3_600_000);
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-3",
        now: muchLater,
      });
      expect(result).toEqual({
        reserved: false,
        reason: "manual_review_required",
      });
    });
  });

  describe("lease 境界 (=)", () => {
    it("leaseExpiresAt === now (秒同値) なら期限切れ扱いで降格", async () => {
      await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-1",
        now: NOW,
      });
      const exactlyAtLease = new Date(
        NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS,
      );
      const result = await tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-2",
        now: exactlyAtLease,
      });
      // <= 比較なので「期限ちょうど」も期限切れと判定
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.reason).toBe("lease_expired_promoted_to_manual_review");
      }
    });
  });
});

describe("markSent", () => {
  it("reserved → sent 遷移、snapshot/messageId/PII hash がセットされる", async () => {
    await tryReserveOrSkip(storage, {
      tenantId: TENANT,
      userId: USER,
      runId: RUN_ID,
      now: NOW,
    });
    await markSent(storage, {
      tenantId: TENANT,
      userId: USER,
      messageId: "msg-xyz",
      notifiedAt: NOW.toISOString(),
      courseIdsSnapshot: ["c1", "c2"],
      progressSnapshot: {
        completedLessons: 5,
        totalLessons: 5,
        coursesCompleted: 2,
        coursesTotal: 2,
      },
      recipientToHash: "sha-to",
      recipientCcHashes: ["sha-cc1", "sha-cc2"],
      pdfSizeBytes: 12345,
    });

    const record = await getReservation(storage, TENANT, USER);
    expect(record?.status).toBe("sent");
    expect(record?.messageId).toBe("msg-xyz");
    expect(record?.notifiedAt).toBe(NOW.toISOString());
    expect(record?.courseIdsSnapshot).toEqual(["c1", "c2"]);
    expect(record?.publishedCourseCount).toBe(2);
    expect(record?.progressSnapshot.completedLessons).toBe(5);
    expect(record?.recipientToHash).toBe("sha-to");
    expect(record?.recipientCcHashes).toEqual(["sha-cc1", "sha-cc2"]);
    expect(record?.pdfSizeBytes).toBe(12345);
  });

  it("予約なしで呼ぶと throw (caller 前提違反検出)", async () => {
    await expect(
      markSent(storage, {
        tenantId: TENANT,
        userId: USER,
        messageId: "msg",
        notifiedAt: NOW.toISOString(),
        courseIdsSnapshot: [],
        progressSnapshot: {
          completedLessons: 0,
          totalLessons: 0,
          coursesCompleted: 0,
          coursesTotal: 0,
        },
        recipientToHash: "",
        recipientCcHashes: [],
        pdfSizeBytes: null,
      }),
    ).rejects.toThrow(/no reservation/);
  });

  it("reserved 以外 (sent) で呼ぶと throw", async () => {
    await seedSentReservation();
    await expect(
      markSent(storage, {
        tenantId: TENANT,
        userId: USER,
        messageId: "msg-2nd",
        notifiedAt: NOW.toISOString(),
        courseIdsSnapshot: [],
        progressSnapshot: {
          completedLessons: 0,
          totalLessons: 0,
          coursesCompleted: 0,
          coursesTotal: 0,
        },
        recipientToHash: "",
        recipientCcHashes: [],
        pdfSizeBytes: null,
      }),
    ).rejects.toThrow(/status must be "reserved"/);
  });
});

describe("markFailedPermanent", () => {
  it("reserved → failed_permanent 遷移、error code/message がセットされる", async () => {
    await tryReserveOrSkip(storage, {
      tenantId: TENANT,
      userId: USER,
      runId: RUN_ID,
      now: NOW,
    });
    await markFailedPermanent(storage, {
      tenantId: TENANT,
      userId: USER,
      failedAt: NOW.toISOString(),
      errorCode: "gmail_recipient_rejected",
      errorMessage: "Recipient rejected (sanitized)",
    });

    const record = await getReservation(storage, TENANT, USER);
    expect(record?.status).toBe("failed_permanent");
    expect(record?.errorCode).toBe("gmail_recipient_rejected");
    expect(record?.errorMessage).toBe("Recipient rejected (sanitized)");
    expect(record?.failedAt).toBe(NOW.toISOString());
  });

  it("予約なしで呼ぶと throw", async () => {
    await expect(
      markFailedPermanent(storage, {
        tenantId: TENANT,
        userId: USER,
        failedAt: NOW.toISOString(),
        errorCode: "x",
        errorMessage: "y",
      }),
    ).rejects.toThrow(/no reservation/);
  });

  it("reserved 以外 (failed_permanent) で呼ぶと throw", async () => {
    await seedFailedPermanent();
    await expect(
      markFailedPermanent(storage, {
        tenantId: TENANT,
        userId: USER,
        failedAt: NOW.toISOString(),
        errorCode: "x",
        errorMessage: "y",
      }),
    ).rejects.toThrow(/status must be "reserved"/);
  });
});

describe("2 並列 worker 同時 reservation (evaluator narrative 反映)", () => {
  it("Promise.all で同 (tenantId, userId) を 2 並列 reserve → 1 件のみ成功", async () => {
    const [a, b] = await Promise.all([
      tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-parallel-a",
        now: NOW,
      }),
      tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-parallel-b",
        now: NOW,
      }),
    ]);
    // 1 件のみ reserved=true (atomicity 担保確認)
    const successes = [a, b].filter((r) => r.reserved).length;
    expect(successes).toBe(1);
    const failed = a.reserved ? b : a;
    expect(failed.reserved).toBe(false);
    if (!failed.reserved) {
      expect(failed.reason).toBe("currently_reserved_by_other_run");
    }
  });

  it("Promise.all で lease 期限切れ既存 reservation を 2 並列 reserve → 1 件のみ降格成功", async () => {
    // 既存 reservation を仕込む
    await tryReserveOrSkip(storage, {
      tenantId: TENANT,
      userId: USER,
      runId: "run-orig",
      now: NOW,
    });
    const expired = new Date(
      NOW.getTime() + DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS + 1000,
    );
    // 2 並列で期限切れ検出 → 両方が降格しようとする
    const [a, b] = await Promise.all([
      tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-a",
        now: expired,
      }),
      tryReserveOrSkip(storage, {
        tenantId: TENANT,
        userId: USER,
        runId: "run-b",
        now: expired,
      }),
    ]);
    // atomicity 保証: 1 件目だけが降格、2 件目は降格後の manual_review_required を検出
    const reasons = [a, b].map((r) => (r.reserved ? "reserved" : r.reason));
    expect(reasons).toContain("lease_expired_promoted_to_manual_review");
    expect(reasons).toContain("manual_review_required");
    const record = await getReservation(storage, TENANT, USER);
    expect(record?.status).toBe("manual_review_required");
  });
});

describe("tenant 分離 / user 分離", () => {
  it("異なる tenantId なら独立した reservation", async () => {
    await tryReserveOrSkip(storage, {
      tenantId: "tenant-A",
      userId: USER,
      runId: RUN_ID,
      now: NOW,
    });
    const result = await tryReserveOrSkip(storage, {
      tenantId: "tenant-B",
      userId: USER,
      runId: RUN_ID,
      now: NOW,
    });
    expect(result).toEqual({ reserved: true });
  });

  it("異なる userId なら独立した reservation", async () => {
    await tryReserveOrSkip(storage, {
      tenantId: TENANT,
      userId: "user-a",
      runId: RUN_ID,
      now: NOW,
    });
    const result = await tryReserveOrSkip(storage, {
      tenantId: TENANT,
      userId: "user-b",
      runId: RUN_ID,
      now: NOW,
    });
    expect(result).toEqual({ reserved: true });
  });
});
