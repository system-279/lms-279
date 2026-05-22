/**
 * FirestoreDispatchStorage の mock-based テスト。
 *
 * 設計仕様書 §4.1.1〜4.1.5、§6.2〜6.3、FR-7 改訂 / FR-11 / FR-12 / NFR-3 対応。
 *
 * テスト戦略 (ADR-028 + 既存 firestore.ts テストパターン踏襲):
 *   - InMemoryDispatchStorage で transaction semantics は既に保証済 (Node.js single-threaded)
 *   - 本テストは Firestore-specific I/O 契約のみ検証する:
 *     - collection path / doc id の正しさ
 *     - ISO 8601 string ↔ Firestore Timestamp の変換
 *     - runTransaction の使用 (read → branch → write 流入を 1 transaction 内に閉じる)
 *     - sanitizeForUpdate (undefined 除去で既存値を保護、production-data-safety.md)
 *     - appendAuditLog の best-effort 性 (Firestore 例外を caller に伝播しない)
 *
 * 並行制御の実 race 検証は Firestore emulator / staging で別途実施 (本 Phase スコープ外)。
 */
import { describe, it, expect, vi } from "vitest";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { DispatchRun } from "@lms-279/shared-types";
import { FirestoreDispatchStorage } from "../firestore-dispatch-storage.js";

// ============================================================
// Firestore mock helpers
// ============================================================

interface MockDoc {
  exists: boolean;
  data: () => Record<string, unknown>;
  id?: string;
}

function buildMockDb() {
  const docCalls: { collection: string; id: string }[] = [];
  const collectionCalls: string[] = [];
  const setCalls: { path: string; data: Record<string, unknown> }[] = [];
  const updateCalls: { path: string; data: Record<string, unknown> }[] = [];
  const queryCalls: {
    collection: string;
    where: [string, string, unknown][];
    limit?: number;
  }[] = [];
  const docState = new Map<string, MockDoc>();
  let nextQueryResult: { docs: MockDoc[]; empty: boolean } = { docs: [], empty: true };

  function setNextQueryResult(docs: MockDoc[]): void {
    nextQueryResult = { docs, empty: docs.length === 0 };
  }

  function buildDocRef(collectionPath: string, docId: string) {
    const path = `${collectionPath}/${docId}`;
    return {
      __path: path,
      id: docId,
      get: vi.fn(async () => docState.get(path) ?? { exists: false, data: () => ({}) }),
      set: vi.fn(async (data: Record<string, unknown>) => {
        setCalls.push({ path, data });
        docState.set(path, { exists: true, data: () => data, id: docId });
      }),
      update: vi.fn(async (data: Record<string, unknown>) => {
        updateCalls.push({ path, data });
        const existing = docState.get(path);
        const merged = existing ? { ...existing.data(), ...data } : data;
        docState.set(path, { exists: true, data: () => merged, id: docId });
      }),
    };
  }

  function buildQuery(collectionPath: string) {
    const wheres: [string, string, unknown][] = [];
    let limitVal: number | undefined;
    const query: Record<string, unknown> = {
      where(field: string, op: string, value: unknown) {
        wheres.push([field, op, value]);
        return query;
      },
      limit(n: number) {
        limitVal = n;
        return query;
      },
      async get() {
        queryCalls.push({
          collection: collectionPath,
          where: [...wheres],
          limit: limitVal,
        });
        return nextQueryResult;
      },
    };
    return query;
  }

  function buildCollection(collectionPath: string) {
    return {
      doc: vi.fn((id: string) => {
        docCalls.push({ collection: collectionPath, id });
        return buildDocRef(collectionPath, id);
      }),
      where(field: string, op: string, value: unknown) {
        const q = buildQuery(collectionPath);
        return (q.where as (f: string, o: string, v: unknown) => unknown)(
          field,
          op,
          value,
        );
      },
      // collection.get() は filter なしの全件取得 (query なしクエリ) を表す
      async get() {
        queryCalls.push({ collection: collectionPath, where: [], limit: undefined });
        return nextQueryResult;
      },
    };
  }

  const runTransaction = vi.fn(async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const tx = {
      async get(refOrQuery: unknown) {
        if ((refOrQuery as { __path?: string })?.__path) {
          const path = (refOrQuery as { __path: string }).__path;
          return docState.get(path) ?? { exists: false, data: () => ({}) };
        }
        if (typeof (refOrQuery as { get?: () => unknown })?.get === "function") {
          return (refOrQuery as { get: () => unknown }).get();
        }
        throw new Error("mock tx.get: unsupported argument");
      },
      set(ref: { __path: string }, data: Record<string, unknown>) {
        setCalls.push({ path: ref.__path, data });
        docState.set(ref.__path, { exists: true, data: () => data });
      },
      update(ref: { __path: string }, data: Record<string, unknown>) {
        updateCalls.push({ path: ref.__path, data });
        const existing = docState.get(ref.__path);
        const merged = existing ? { ...existing.data(), ...data } : data;
        docState.set(ref.__path, { exists: true, data: () => merged });
      },
    };
    return fn(tx);
  });

  const db = {
    collection: vi.fn((name: string) => {
      collectionCalls.push(name);
      return buildCollection(name);
    }),
    doc: vi.fn((path: string) => {
      const lastSlash = path.lastIndexOf("/");
      const colPath = path.substring(0, lastSlash);
      const docId = path.substring(lastSlash + 1);
      docCalls.push({ collection: colPath, id: docId });
      return buildDocRef(colPath, docId);
    }),
    runTransaction,
  } as unknown as Firestore;

  return {
    db,
    docCalls,
    collectionCalls,
    setCalls,
    updateCalls,
    queryCalls,
    docState,
    setNextQueryResult,
    runTransaction,
    seedDoc(path: string, data: Record<string, unknown>) {
      docState.set(path, { exists: true, data: () => data });
    },
  };
}

const NOW_ISO = "2026-05-22T01:00:00.000Z";
const NOW_DATE = new Date(NOW_ISO);

// ============================================================
// getDispatchSettings
// ============================================================

describe("FirestoreDispatchStorage.getDispatchSettings", () => {
  it("super_dispatch_settings/global を読み取り、Timestamp を ISO に変換する", async () => {
    const m = buildMockDb();
    const updatedAt = Timestamp.fromDate(new Date("2026-05-21T03:00:00.000Z"));
    m.seedDoc("super_dispatch_settings/global", {
      enabled: true,
      scheduleDaysOfWeek: [1, 4],
      scheduleHourJst: 9,
      signatureName: "DXcollege運営スタッフ",
      completionMessageBody: "受講お疲れ様でした。",
      senderEmail: "dxcollege@279279.net",
      updatedAt,
      updatedBy: "admin@example.com",
      version: 3,
    });

    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.getDispatchSettings();

    expect(m.docCalls[0]).toEqual({
      collection: "super_dispatch_settings",
      id: "global",
    });
    expect(result).toEqual({
      enabled: true,
      scheduleDaysOfWeek: [1, 4],
      scheduleHourJst: 9,
      signatureName: "DXcollege運営スタッフ",
      completionMessageBody: "受講お疲れ様でした。",
      senderEmail: "dxcollege@279279.net",
      updatedAt: "2026-05-21T03:00:00.000Z",
      updatedBy: "admin@example.com",
      version: 3,
    });
  });

  it("doc 不在なら null を返す", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.getDispatchSettings();
    expect(result).toBeNull();
  });
});

// ============================================================
// updateDispatchSettings (transaction + 楽観ロック)
// ============================================================

describe("FirestoreDispatchStorage.updateDispatchSettings", () => {
  const baseInput = {
    enabled: true,
    scheduleDaysOfWeek: [1, 4],
    scheduleHourJst: 9,
    signatureName: "DXcollege運営スタッフ",
    completionMessageBody: "受講お疲れ様でした。",
    senderEmail: "dxcollege@279279.net",
    updatedBy: "admin@example.com",
    updatedAt: NOW_ISO,
  };

  it("doc 未作成 + expectedVersion=0 で runTransaction 内 set、version=1", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.updateDispatchSettings({
      ...baseInput,
      expectedVersion: 0,
    });
    expect(m.runTransaction).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("unreachable");
    expect(result.settings.version).toBe(1);
    // set は settings/global に対して行われ、updatedAt は Timestamp 化される
    const setCall = m.setCalls.find(
      (c) => c.path === "super_dispatch_settings/global",
    );
    expect(setCall).toBeDefined();
    expect(setCall?.data.version).toBe(1);
    expect(setCall?.data.updatedAt).toBeInstanceOf(Timestamp);
  });

  it("既存 version 一致で version を +1 して set", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_settings/global", {
      enabled: false,
      scheduleDaysOfWeek: [],
      scheduleHourJst: 0,
      signatureName: "x",
      completionMessageBody: "y",
      senderEmail: "dxcollege@279279.net",
      updatedAt: Timestamp.fromDate(NOW_DATE),
      updatedBy: "prev@example.com",
      version: 3,
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.updateDispatchSettings({
      ...baseInput,
      expectedVersion: 3,
    });
    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("unreachable");
    expect(result.settings.version).toBe(4);
  });

  it("version 不一致は version_conflict で current を返し set しない", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_settings/global", {
      enabled: true,
      scheduleDaysOfWeek: [2],
      scheduleHourJst: 8,
      signatureName: "現在スタッフ",
      completionMessageBody: "現在本文",
      senderEmail: "dxcollege@279279.net",
      updatedAt: Timestamp.fromDate(NOW_DATE),
      updatedBy: "prev@example.com",
      version: 5,
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.updateDispatchSettings({
      ...baseInput,
      expectedVersion: 1, // stale
    });
    expect(result.updated).toBe(false);
    if (result.updated) throw new Error("unreachable");
    expect(result.reason).toBe("version_conflict");
    expect(result.current?.version).toBe(5);
    expect(result.current?.signatureName).toBe("現在スタッフ");
    expect(m.setCalls).toHaveLength(0);
  });
});

// ============================================================
// listRuns
// ============================================================

describe("FirestoreDispatchStorage.listRuns", () => {
  it("super_dispatch_runs を全件取得し DispatchRun に変換する", async () => {
    const m = buildMockDb();
    const trig = Timestamp.fromDate(NOW_DATE);
    const lease = Timestamp.fromDate(new Date("2026-05-22T01:04:40.000Z"));
    const ttl = Timestamp.fromDate(new Date("2027-05-22T01:00:00.000Z"));
    m.setNextQueryResult([
      {
        exists: true,
        data: () => ({
          runId: "run-1",
          triggeredAt: trig,
          status: "completed",
          leaseExpiresAt: lease,
          processedTenants: 2,
          sent: 3,
          skipped: 1,
          failed: 0,
          manualReviewRequired: 0,
          abortedReason: null,
          ttlExpireAt: ttl,
        }),
      },
    ]);
    const storage = new FirestoreDispatchStorage(m.db);
    const runs = await storage.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-1");
    expect(runs[0].triggeredAt).toBe(NOW_ISO);
    expect(runs[0].sent).toBe(3);
    // collection().get() の全件クエリが呼ばれている
    expect(m.queryCalls.some((q) => q.collection === "super_dispatch_runs")).toBe(
      true,
    );
  });

  it("run 未登録なら空配列", async () => {
    const m = buildMockDb();
    m.setNextQueryResult([]);
    const storage = new FirestoreDispatchStorage(m.db);
    expect(await storage.listRuns()).toEqual([]);
  });
});

// ============================================================
// tryReserveCompletionNotification (transaction)
// ============================================================

describe("FirestoreDispatchStorage.tryReserveCompletionNotification", () => {
  const baseInput = {
    tenantId: "tenant-a",
    userId: "user-1",
    runId: "run-uuid-1",
    now: NOW_ISO,
    leaseExpiresAt: "2026-05-22T01:10:00.000Z",
  };

  it("レコード不在 → reserved=true、tenants/{tid}/completion_notifications/{uid} に set", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.tryReserveCompletionNotification(baseInput);

    expect(result).toEqual({ reserved: true });
    expect(m.runTransaction).toHaveBeenCalledTimes(1);
    expect(m.setCalls).toHaveLength(1);
    expect(m.setCalls[0].path).toBe(
      "tenants/tenant-a/completion_notifications/user-1",
    );
    const written = m.setCalls[0].data;
    expect(written.userId).toBe("user-1");
    expect(written.status).toBe("reserved");
    expect(written.runId).toBe("run-uuid-1");
    expect((written.reservedAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
    expect((written.leaseExpiresAt as Timestamp).toDate().toISOString()).toBe(
      "2026-05-22T01:10:00.000Z",
    );
  });

  it("既存 sent → reserved=false, reason=already_sent (新規 write なし)", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      userId: "user-1",
      status: "sent",
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.tryReserveCompletionNotification(baseInput);
    expect(result).toEqual({ reserved: false, reason: "already_sent" });
    expect(m.setCalls).toHaveLength(0);
    expect(m.updateCalls).toHaveLength(0);
  });

  it("既存 failed_permanent → reserved=false, reason=failed_permanent", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "failed_permanent",
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.tryReserveCompletionNotification(baseInput);
    expect(result).toEqual({ reserved: false, reason: "failed_permanent" });
  });

  it("既存 manual_review_required → reserved=false, reason=manual_review_required", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "manual_review_required",
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.tryReserveCompletionNotification(baseInput);
    expect(result).toEqual({ reserved: false, reason: "manual_review_required" });
  });

  it("既存 reserved (lease 期限内) → reserved=false, reason=currently_reserved_by_other_run", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "reserved",
      leaseExpiresAt: Timestamp.fromDate(new Date(NOW_DATE.getTime() + 60_000)),
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.tryReserveCompletionNotification(baseInput);
    expect(result).toEqual({
      reserved: false,
      reason: "currently_reserved_by_other_run",
    });
    expect(m.setCalls).toHaveLength(0);
    expect(m.updateCalls).toHaveLength(0);
  });

  it("既存 reserved (lease 期限切れ) → manual_review_required に降格、reserved=false", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "reserved",
      leaseExpiresAt: Timestamp.fromDate(new Date(NOW_DATE.getTime() - 60_000)),
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.tryReserveCompletionNotification(baseInput);
    expect(result).toEqual({
      reserved: false,
      reason: "lease_expired_promoted_to_manual_review",
    });
    expect(m.updateCalls).toHaveLength(1);
    expect(m.updateCalls[0].path).toBe(
      "tenants/tenant-a/completion_notifications/user-1",
    );
    expect(m.updateCalls[0].data.status).toBe("manual_review_required");
    expect((m.updateCalls[0].data.failedAt as Timestamp).toDate().toISOString()).toBe(
      NOW_ISO,
    );
  });
});

// ============================================================
// markCompletionNotificationSent / FailedPermanent
// ============================================================

describe("FirestoreDispatchStorage.markCompletionNotificationSent", () => {
  it("reserved 不在なら throw", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    await expect(
      storage.markCompletionNotificationSent({
        tenantId: "tenant-a",
        userId: "user-1",
        messageId: "msg-1",
        notifiedAt: NOW_ISO,
        courseIdsSnapshot: ["c1", "c2"],
        progressSnapshot: {
          completedLessons: 10,
          totalLessons: 10,
          coursesCompleted: 2,
          coursesTotal: 2,
        },
        recipientToHash: "hash-to",
        recipientCcHashes: ["hash-cc-1"],
        pdfSizeBytes: 12345,
      }),
    ).rejects.toThrow(/no reservation/);
  });

  it("既存 reserved → update で status=sent + sent fields", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "reserved",
    });
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.markCompletionNotificationSent({
      tenantId: "tenant-a",
      userId: "user-1",
      messageId: "msg-1",
      notifiedAt: NOW_ISO,
      courseIdsSnapshot: ["c1", "c2"],
      progressSnapshot: {
        completedLessons: 10,
        totalLessons: 10,
        coursesCompleted: 2,
        coursesTotal: 2,
      },
      recipientToHash: "hash-to",
      recipientCcHashes: ["hash-cc-1"],
      pdfSizeBytes: 12345,
    });
    expect(m.updateCalls).toHaveLength(1);
    expect(m.updateCalls[0].path).toBe(
      "tenants/tenant-a/completion_notifications/user-1",
    );
    const data = m.updateCalls[0].data;
    expect(data.status).toBe("sent");
    expect(data.messageId).toBe("msg-1");
    expect((data.notifiedAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
    expect(data.courseIdsSnapshot).toEqual(["c1", "c2"]);
    expect(data.publishedCourseCount).toBe(2);
    expect(data.pdfSizeBytes).toBe(12345);
  });

  it("既存 status=sent (reserved 以外) → throw", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "sent",
    });
    const storage = new FirestoreDispatchStorage(m.db);
    await expect(
      storage.markCompletionNotificationSent({
        tenantId: "tenant-a",
        userId: "user-1",
        messageId: "msg-1",
        notifiedAt: NOW_ISO,
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

describe("FirestoreDispatchStorage.markCompletionNotificationFailedPermanent", () => {
  it("既存 reserved → status=failed_permanent + errorCode/Message/failedAt 更新", async () => {
    const m = buildMockDb();
    m.seedDoc("tenants/tenant-a/completion_notifications/user-1", {
      status: "reserved",
    });
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.markCompletionNotificationFailedPermanent({
      tenantId: "tenant-a",
      userId: "user-1",
      failedAt: NOW_ISO,
      errorCode: "recipientRejected",
      errorMessage: "user-bounce (sanitized)",
    });
    expect(m.updateCalls).toHaveLength(1);
    const data = m.updateCalls[0].data;
    expect(data.status).toBe("failed_permanent");
    expect(data.errorCode).toBe("recipientRejected");
    expect(data.errorMessage).toBe("user-bounce (sanitized)");
    expect((data.failedAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
  });
});

// ============================================================
// acquireRunLock
// ============================================================

describe("FirestoreDispatchStorage.acquireRunLock", () => {
  const baseInput = {
    runId: "run-uuid-1",
    triggeredAt: NOW_ISO,
    leaseExpiresAt: "2026-05-22T01:04:40.000Z",
    ttlExpireAt: "2027-05-22T01:00:00.000Z",
  };

  it("既存 running なし → acquired=true、super_dispatch_runs/{runId} に set", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.acquireRunLock(baseInput);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.run.runId).toBe("run-uuid-1");
      expect(result.run.status).toBe("running");
    }
    expect(m.setCalls).toHaveLength(1);
    expect(m.setCalls[0].path).toBe("super_dispatch_runs/run-uuid-1");
    const data = m.setCalls[0].data;
    expect(data.status).toBe("running");
    expect((data.triggeredAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
    expect((data.leaseExpiresAt as Timestamp).toDate().toISOString()).toBe(
      "2026-05-22T01:04:40.000Z",
    );
    expect((data.ttlExpireAt as Timestamp).toDate().toISOString()).toBe(
      "2027-05-22T01:00:00.000Z",
    );
  });

  it("既存 duplicate runId → acquired=false, reason=duplicate_run_id (set なし)", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_runs/run-uuid-1", { status: "running" });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.acquireRunLock(baseInput);
    expect(result).toEqual({ acquired: false, reason: "duplicate_run_id" });
    expect(m.setCalls).toHaveLength(0);
  });

  it("別の running run が lease 期限内 → acquired=false, reason=another_run_active", async () => {
    const m = buildMockDb();
    m.setNextQueryResult([
      {
        exists: true,
        data: () => ({
          runId: "other-run",
          status: "running",
          triggeredAt: Timestamp.fromDate(new Date(NOW_DATE.getTime() - 60_000)),
          leaseExpiresAt: Timestamp.fromDate(new Date(NOW_DATE.getTime() + 60_000)),
        }),
      },
    ]);
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.acquireRunLock(baseInput);
    expect(result).toEqual({ acquired: false, reason: "another_run_active" });
    expect(m.setCalls).toHaveLength(0);
  });
});

// ============================================================
// updateRunStatus
// ============================================================

describe("FirestoreDispatchStorage.updateRunStatus", () => {
  it("既存 running → update で status=completed + metrics", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_runs/run-uuid-1", { status: "running" });
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.updateRunStatus({
      runId: "run-uuid-1",
      status: "completed",
      processedTenants: 3,
      sent: 5,
      skipped: 2,
      failed: 1,
      manualReviewRequired: 0,
    });
    expect(m.updateCalls).toHaveLength(1);
    expect(m.updateCalls[0].path).toBe("super_dispatch_runs/run-uuid-1");
    expect(m.updateCalls[0].data).toMatchObject({
      status: "completed",
      processedTenants: 3,
      sent: 5,
      skipped: 2,
      failed: 1,
      manualReviewRequired: 0,
    });
  });

  it("undefined フィールドは sanitizeForUpdate で除去される (既存値保護)", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_runs/run-uuid-1", { status: "running" });
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.updateRunStatus({
      runId: "run-uuid-1",
      status: "completed",
    });
    expect(m.updateCalls).toHaveLength(1);
    const data = m.updateCalls[0].data;
    expect(data.status).toBe("completed");
    expect("processedTenants" in data).toBe(false);
    expect("sent" in data).toBe(false);
  });

  it("aborted 遷移時に abortedReason をセット", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_runs/run-uuid-1", { status: "running" });
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.updateRunStatus({
      runId: "run-uuid-1",
      status: "aborted",
      abortedReason: "scope_revoked",
    });
    expect(m.updateCalls).toHaveLength(1);
    expect(m.updateCalls[0].data).toMatchObject({
      status: "aborted",
      abortedReason: "scope_revoked",
    });
  });

  it("run 不在 → throw", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    await expect(
      storage.updateRunStatus({ runId: "unknown", status: "completed" }),
    ).rejects.toThrow(/no run found/);
  });
});

// ============================================================
// getRun
// ============================================================

describe("FirestoreDispatchStorage.getRun", () => {
  it("doc 不在 → null", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.getRun("unknown");
    expect(result).toBeNull();
  });

  it("doc 存在 → Timestamp を ISO に変換して返す", async () => {
    const m = buildMockDb();
    m.seedDoc("super_dispatch_runs/run-uuid-1", {
      runId: "run-uuid-1",
      triggeredAt: Timestamp.fromDate(NOW_DATE),
      status: "running",
      leaseExpiresAt: Timestamp.fromDate(new Date(NOW_DATE.getTime() + 280_000)),
      processedTenants: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      manualReviewRequired: 0,
      abortedReason: null,
      ttlExpireAt: Timestamp.fromDate(
        new Date(NOW_DATE.getTime() + 365 * 86_400_000),
      ),
    });
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.getRun("run-uuid-1");
    expect(result).not.toBeNull();
    const r = result as DispatchRun;
    expect(r.runId).toBe("run-uuid-1");
    expect(r.status).toBe("running");
    expect(r.triggeredAt).toBe(NOW_ISO);
    expect(typeof r.leaseExpiresAt).toBe("string");
    expect(typeof r.ttlExpireAt).toBe("string");
  });
});

// ============================================================
// appendAuditLog (best-effort)
// ============================================================

describe("FirestoreDispatchStorage.appendAuditLog", () => {
  const sampleInput = {
    auditId: "audit-1",
    runId: "run-uuid-1",
    runStartedAt: NOW_ISO,
    eventType: "user_notified" as const,
    tenantId: "tenant-a",
    userId: "user-1",
    errorCode: null,
    errorMessage: null,
    durationMs: 1234,
    createdAt: NOW_ISO,
    ttlExpireAt: "2027-05-22T01:00:00.000Z",
  };

  it("super_dispatch_audit_logs/{auditId} に set、Timestamp 変換", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.appendAuditLog(sampleInput);
    expect(m.setCalls).toHaveLength(1);
    expect(m.setCalls[0].path).toBe("super_dispatch_audit_logs/audit-1");
    const data = m.setCalls[0].data;
    expect(data.eventType).toBe("user_notified");
    expect((data.createdAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
    expect((data.ttlExpireAt as Timestamp).toDate().toISOString()).toBe(
      "2027-05-22T01:00:00.000Z",
    );
  });

  it("Firestore 書き込みが throw しても caller に伝播しない (best-effort)", async () => {
    const failingDb = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          set: vi.fn().mockRejectedValue(new Error("Firestore down")),
        })),
      })),
    } as unknown as Firestore;
    const storage = new FirestoreDispatchStorage(failingDb);
    await expect(storage.appendAuditLog(sampleInput)).resolves.toBeUndefined();
  });
});

describe("FirestoreDispatchStorage.listAuditLogs", () => {
  it("filter なしで全件取得、Timestamp を ISO に変換", async () => {
    const m = buildMockDb();
    const ts = Timestamp.fromDate(NOW_DATE);
    m.setNextQueryResult([
      {
        exists: true,
        id: "audit-1",
        data: () => ({
          auditId: "audit-1",
          runId: "run-1",
          runStartedAt: ts,
          eventType: "run_started",
          tenantId: null,
          userId: null,
          errorCode: null,
          errorMessage: null,
          durationMs: null,
          createdAt: ts,
          ttlExpireAt: ts,
        }),
      },
    ]);
    const storage = new FirestoreDispatchStorage(m.db);
    const result = await storage.listAuditLogs();
    expect(result).toHaveLength(1);
    expect(result[0].auditId).toBe("audit-1");
    expect(result[0].createdAt).toBe(NOW_ISO);
  });

  it("runId / eventType フィルタを query に追加", async () => {
    const m = buildMockDb();
    const storage = new FirestoreDispatchStorage(m.db);
    await storage.listAuditLogs({ runId: "run-1", eventType: "user_notified" });
    expect(m.queryCalls).toHaveLength(1);
    const wheres = m.queryCalls[0].where;
    expect(wheres).toEqual(
      expect.arrayContaining([
        ["runId", "==", "run-1"],
        ["eventType", "==", "user_notified"],
      ]),
    );
  });
});
