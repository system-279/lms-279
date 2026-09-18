/**
 * InMemoryDispatchStorage.listSendHistoryShard のテスト (PR2a、送信実績一覧)。
 *
 * Fable レビューで判明した2つの正確性要件をカバー:
 *   - tiebreaker: 同一 processedAt (同一ミリ秒 claim) でも取りこぼし/重複が無いこと
 *   - lane/tenantId フィルタで他テナント・他レーンのデータが混ざらないこと
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";
const RUN_1 = "run-uuid-1";
const OCC_1 = "occ-2026-06-03-09";

describe("InMemoryDispatchStorage.listSendHistoryShard", () => {
  let storage: InMemoryDispatchStorage;
  beforeEach(() => {
    storage = new InMemoryDispatchStorage();
  });

  it("データが無いテナントは空配列を返す", async () => {
    const items = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "completion",
      limit: 50,
    });
    expect(items).toEqual([]);
  });

  it("completion レーン: reservedAt 降順で返し、sentAt/status を反映する", async () => {
    await storage.tryReserveCompletionNotification({
      tenantId: TENANT_A,
      userId: "user-1",
      runId: RUN_1,
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });
    await storage.markCompletionNotificationSent({
      tenantId: TENANT_A,
      userId: "user-1",
      messageId: "msg-1",
      notifiedAt: "2026-06-03T01:00:05.000Z",
      progressSnapshot: {
        completedLessons: 1,
        totalLessons: 1,
        coursesCompleted: 1,
        coursesTotal: 1,
      },
      courseIdsSnapshot: ["course-1"],
      recipientToHash: "hash-1",
      recipientCcHashes: [],
      pdfSizeBytes: null,
    });
    await storage.tryReserveCompletionNotification({
      tenantId: TENANT_A,
      userId: "user-2",
      runId: RUN_1,
      now: "2026-06-03T02:00:00.000Z",
      leaseExpiresAt: "2026-06-03T02:10:00.000Z",
    });

    const items = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "completion",
      limit: 50,
    });
    expect(items).toHaveLength(2);
    // reservedAt 降順 (user-2 が後から予約 = 新しい)
    expect(items[0].userId).toBe("user-2");
    expect(items[0].status).toBe("reserved");
    expect(items[0].sentAt).toBeNull();
    expect(items[1].userId).toBe("user-1");
    expect(items[1].status).toBe("sent");
    expect(items[1].sentAt).toBe("2026-06-03T01:00:05.000Z");
  });

  it("progress レーン: claimedAt 降順で返す", async () => {
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: "user-1",
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
      ttlExpireAt: "2026-09-01T00:00:00.000Z",
    });
    await storage.tryClaimProgressRecipient({
      tenantId: TENANT_A,
      userId: "user-2",
      occurrenceId: OCC_1,
      runId: RUN_1,
      now: "2026-06-03T02:00:00.000Z",
      leaseExpiresAt: "2026-06-03T02:10:00.000Z",
      ttlExpireAt: "2026-09-01T00:00:00.000Z",
    });

    const items = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "progress",
      limit: 50,
    });
    expect(items.map((i) => i.userId)).toEqual(["user-2", "user-1"]);
    expect(items[0].docId).toBe(`${OCC_1}__user-2`);
  });

  it("tenantId フィルタ: 他テナントのデータが混ざらない", async () => {
    await storage.tryReserveCompletionNotification({
      tenantId: TENANT_A,
      userId: "user-1",
      runId: RUN_1,
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });
    await storage.tryReserveCompletionNotification({
      tenantId: TENANT_B,
      userId: "user-1",
      runId: RUN_1,
      now: "2026-06-03T01:00:00.000Z",
      leaseExpiresAt: "2026-06-03T01:10:00.000Z",
    });

    const itemsA = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "completion",
      limit: 50,
    });
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0].tenantId).toBe(TENANT_A);
  });

  it("同一 processedAt でも docId tiebreaker で取りこぼし・重複なくページングできる (Fable レビュー)", async () => {
    // 並列 claim を模擬: 同一 now (同一ミリ秒) で3件 claim
    const SAME_NOW = "2026-06-03T01:00:00.000Z";
    for (const userId of ["user-a", "user-b", "user-c"]) {
      await storage.tryClaimProgressRecipient({
        tenantId: TENANT_A,
        userId,
        occurrenceId: OCC_1,
        runId: RUN_1,
        now: SAME_NOW,
        leaseExpiresAt: "2026-06-03T01:10:00.000Z",
        ttlExpireAt: "2026-09-01T00:00:00.000Z",
      });
    }

    // limit=2 で1ページ目を取得 → 全件のうちdocId降順で上位2件のはず
    const page1 = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "progress",
      limit: 2,
    });
    expect(page1).toHaveLength(2);

    // page1 の最後の要素をカーソルに、残りを取得
    const lastOfPage1 = page1[page1.length - 1];
    const page2 = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "progress",
      limit: 2,
      after: { processedAt: lastOfPage1.processedAt, docId: lastOfPage1.docId },
    });

    // 合計3件、重複・欠落なし
    const allUserIds = [...page1, ...page2].map((i) => i.userId).sort();
    expect(allUserIds).toEqual(["user-a", "user-b", "user-c"]);
    expect(new Set(allUserIds).size).toBe(3);
  });

  it("limit で件数が絞られる", async () => {
    for (const userId of ["user-1", "user-2", "user-3"]) {
      await storage.tryReserveCompletionNotification({
        tenantId: TENANT_A,
        userId,
        runId: RUN_1,
        now: "2026-06-03T01:00:00.000Z",
        leaseExpiresAt: "2026-06-03T01:10:00.000Z",
      });
    }
    const items = await storage.listSendHistoryShard({
      tenantId: TENANT_A,
      lane: "completion",
      limit: 1,
    });
    expect(items).toHaveLength(1);
  });
});
