/**
 * dispatch-audit の Integration テスト。
 *
 * 設計仕様書 §4.1.5、§6.5、NFR-4 / NFR-11、AC-33、Phase 2 完了条件:
 *   - audit_logs に PII 漏洩がないことを assertion
 *
 * 観点:
 *   - 通常 append: auditId 生成、createdAt / ttlExpireAt 算出、storage に書き込まれる
 *   - errorMessage が unknown / Error / string / null すべて受け付ける
 *   - errorMessage に email を含めば sanitize されて保存される (NFR-11)
 *   - storage が throw しても caller には例外伝搬しない (§6.1 best-effort)
 *   - warn 注入で warning ログが呼ばれる (observability)
 *   - auditIdGenerator 注入で固定 ID
 *   - tenantId / userId / errorCode / durationMs が省略時 null
 *   - ttlExpireAt = now + AUDIT_LOGS_TTL_DAYS (365 日)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DISPATCH_CONSTRAINTS,
  type DispatchAuditLog,
} from "@lms-279/shared-types";
import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";
import type {
  AppendAuditLogInput,
  DispatchStorage,
} from "../dispatch-storage.js";
import { recordAuditLog } from "../dispatch-audit.js";

const NOW = new Date("2026-05-22T02:00:00.000Z");
const RUN_ID = "run-uuid-99";
const RUN_STARTED_AT = "2026-05-22T01:55:00.000Z";

let storage: InMemoryDispatchStorage;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
});

describe("recordAuditLog - 通常 append", () => {
  it("auditId 生成、createdAt = now、ttlExpireAt = now + 365 日", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "run_started",
      now: NOW,
      auditIdGenerator: () => "audit-fixed-1",
    });

    const logs = await storage.listAuditLogs({ runId: RUN_ID });
    expect(logs).toHaveLength(1);
    expect(logs[0].auditId).toBe("audit-fixed-1");
    expect(logs[0].createdAt).toBe(NOW.toISOString());
    const expectedTtlMs =
      NOW.getTime() +
      DISPATCH_CONSTRAINTS.AUDIT_LOGS_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(logs[0].ttlExpireAt).toBe(new Date(expectedTtlMs).toISOString());
  });

  it("eventType / runId / runStartedAt が保存される", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_notified",
      tenantId: "tenant-A",
      userId: "user-1",
      durationMs: 1234,
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].runId).toBe(RUN_ID);
    expect(logs[0].runStartedAt).toBe(RUN_STARTED_AT);
    expect(logs[0].eventType).toBe("user_notified");
    expect(logs[0].tenantId).toBe("tenant-A");
    expect(logs[0].userId).toBe("user-1");
    expect(logs[0].durationMs).toBe(1234);
  });

  it("省略可 field は null で保存される", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "run_started",
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].tenantId).toBeNull();
    expect(logs[0].userId).toBeNull();
    expect(logs[0].errorCode).toBeNull();
    expect(logs[0].errorMessage).toBeNull();
    expect(logs[0].durationMs).toBeNull();
  });
});

describe("recordAuditLog - PII sanitize (NFR-11、AC-33)", () => {
  it("errorMessage に email を含めば [EMAIL] に redacted", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_failed_permanent",
      tenantId: "tenant-A",
      userId: "user-1",
      errorCode: "gmail_api_error",
      errorMessage: "Send failed to alice@example.com",
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].errorMessage).toBe("Send failed to [EMAIL]");
    // 元 email が完全に除去されていることを assertion
    expect(logs[0].errorMessage).not.toContain("alice@example.com");
  });

  it("errorMessage に access token / Bearer を含めば redacted", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_failed_permanent",
      errorMessage:
        "Auth failed: Bearer ya29.A0AfH6SMBxXx_test_token rejected",
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].errorMessage).not.toMatch(/ya29\./);
    expect(logs[0].errorMessage).not.toContain("Bearer ya29");
  });

  it("errorMessage に MIME headers を含めば redacted", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_failed_permanent",
      errorMessage: "Header validation failed:\nTo: victim@x.com",
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].errorMessage).not.toMatch(/To:\s*victim@x.com/);
  });

  it("Error オブジェクトを渡せば message を抽出して sanitize", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_failed_permanent",
      errorMessage: new Error("Recipient rejected: charlie@example.org"),
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].errorMessage).toBe("Recipient rejected: [EMAIL]");
  });

  it("errorMessage = null は null のまま (sanitize しない)", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "run_started",
      errorMessage: null,
      now: NOW,
    });

    const logs = await storage.listAuditLogs();
    expect(logs[0].errorMessage).toBeNull();
  });
});

describe("recordAuditLog - best-effort (§6.1)", () => {
  /** appendAuditLog が必ず throw する障害 storage */
  function makeFailingStorage(): DispatchStorage {
    return {
      getDispatchSettings: vi.fn(() => Promise.resolve(null)),
      tryReserveCompletionNotification: vi.fn(),
      markCompletionNotificationSent: vi.fn(),
      markCompletionNotificationFailedPermanent: vi.fn(),
      getCompletionNotification: vi.fn(),
      updateDispatchSettings: vi.fn(),
      acquireRunLock: vi.fn(),
      updateRunStatus: vi.fn(),
      getRun: vi.fn(),
      listRuns: vi.fn(() => Promise.resolve([])),
      appendAuditLog: vi.fn(
        (_input: AppendAuditLogInput): Promise<void> =>
          Promise.reject(new Error("Firestore unavailable")),
      ),
      listAuditLogs: vi.fn(
        (): Promise<DispatchAuditLog[]> => Promise.resolve([]),
      ),
      // Phase 3 (ADR-039): 本テストでは呼び出されないため no-op stub
      acquireLaneLock: vi.fn(),
      completeLaneLock: vi.fn(),
      abortLaneLock: vi.fn(),
      tryClaimProgressRecipient: vi.fn(),
      markProgressRecipientSent: vi.fn(),
      markProgressRecipientFailed: vi.fn(),
      promotePendingToManualReview: vi.fn(),
      getProgressRecipient: vi.fn(),
    };
  }

  it("storage が throw しても caller には例外伝搬しない (resolve)", async () => {
    const failing = makeFailingStorage();
    const warn = vi.fn();
    await expect(
      recordAuditLog(
        failing,
        {
          runId: RUN_ID,
          runStartedAt: RUN_STARTED_AT,
          eventType: "user_notified",
          now: NOW,
        },
        warn,
      ),
    ).resolves.toBeUndefined();
  });

  it("storage が throw した時、warn callback が呼ばれる (observability)", async () => {
    const failing = makeFailingStorage();
    const warn = vi.fn();
    await recordAuditLog(
      failing,
      {
        runId: RUN_ID,
        runStartedAt: RUN_STARTED_AT,
        eventType: "user_notified",
        tenantId: "tenant-A",
        userId: "user-x",
        now: NOW,
      },
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/appendAuditLog failed/);
    const meta = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(meta.runId).toBe(RUN_ID);
    expect(meta.eventType).toBe("user_notified");
    expect(meta.tenantId).toBe("tenant-A");
    expect(meta.userId).toBe("user-x");
  });

  it("warn meta の errorMessage は storage error message を sanitize 済で出す", async () => {
    const storageThatThrowsWithEmail: DispatchStorage = {
      getDispatchSettings: vi.fn(() => Promise.resolve(null)),
      tryReserveCompletionNotification: vi.fn(),
      markCompletionNotificationSent: vi.fn(),
      markCompletionNotificationFailedPermanent: vi.fn(),
      getCompletionNotification: vi.fn(),
      updateDispatchSettings: vi.fn(),
      acquireRunLock: vi.fn(),
      updateRunStatus: vi.fn(),
      getRun: vi.fn(),
      listRuns: vi.fn(() => Promise.resolve([])),
      appendAuditLog: vi.fn(() =>
        Promise.reject(new Error("Conflict on user secret@x.com")),
      ),
      listAuditLogs: vi.fn(() => Promise.resolve([])),
      // Phase 3 (ADR-039): 本テストでは呼び出されないため no-op stub
      acquireLaneLock: vi.fn(),
      completeLaneLock: vi.fn(),
      abortLaneLock: vi.fn(),
      tryClaimProgressRecipient: vi.fn(),
      markProgressRecipientSent: vi.fn(),
      markProgressRecipientFailed: vi.fn(),
      promotePendingToManualReview: vi.fn(),
      getProgressRecipient: vi.fn(),
    };
    const warn = vi.fn();
    await recordAuditLog(
      storageThatThrowsWithEmail,
      {
        runId: RUN_ID,
        runStartedAt: RUN_STARTED_AT,
        eventType: "user_failed_permanent",
        now: NOW,
      },
      warn,
    );
    const meta = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(meta.errorMessage).toBe("Conflict on user [EMAIL]");
  });
});

describe("recordAuditLog - auditId 自動生成 (default randomUUID)", () => {
  it("auditIdGenerator 省略時は randomUUID で UUID 形式", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "run_started",
      now: NOW,
    });
    const logs = await storage.listAuditLogs();
    // UUID v4 形式 (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
    expect(logs[0].auditId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("複数 append で auditId が重複しない", async () => {
    for (let i = 0; i < 5; i++) {
      await recordAuditLog(storage, {
        runId: RUN_ID,
        runStartedAt: RUN_STARTED_AT,
        eventType: "user_skipped",
        now: NOW,
      });
    }
    const logs = await storage.listAuditLogs();
    const ids = new Set(logs.map((l) => l.auditId));
    expect(ids.size).toBe(5);
  });
});

describe("filter (listAuditLogs)", () => {
  it("runId で絞り込み", async () => {
    await recordAuditLog(storage, {
      runId: "run-a",
      runStartedAt: RUN_STARTED_AT,
      eventType: "run_started",
      now: NOW,
    });
    await recordAuditLog(storage, {
      runId: "run-b",
      runStartedAt: RUN_STARTED_AT,
      eventType: "run_started",
      now: NOW,
    });

    const a = await storage.listAuditLogs({ runId: "run-a" });
    expect(a).toHaveLength(1);
    expect(a[0].runId).toBe("run-a");
  });

  it("eventType で絞り込み", async () => {
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_notified",
      now: NOW,
    });
    await recordAuditLog(storage, {
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      eventType: "user_skipped",
      now: NOW,
    });

    const notified = await storage.listAuditLogs({ eventType: "user_notified" });
    expect(notified).toHaveLength(1);
    expect(notified[0].eventType).toBe("user_notified");
  });
});
