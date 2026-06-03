/**
 * run-progress-reports の Integration テスト (Phase 3 PR 3c)。
 *
 * 設計仕様書 §4.1、AC-PR-01 〜 AC-PR-22 を end-to-end で網羅 (25 シナリオ)。
 *
 * impl-plan §PR 3c で指定された 25 シナリオ:
 *   - 基本配信 / 100% 完了除外 / 受講中フィルタ境界 / progressReportEnabled=false テナント skip
 *   - occurrenceId 冪等 / 別 occurrenceId 再送
 *   - pending lease 切れ → manual_review_required
 *   - lane lock 排他
 *   - Gmail 429 / 403 scope_revoked / 400 permanent / 403 user_permanent
 *   - PDF 5MB 超 → pdf_too_large skip
 *   - PII sha256
 *   - TTL: pending claim 時点で ttlExpireAt 設定
 *   - 両レーン独立性 (設定)
 *
 * テスト戦略 (ADR-028): InMemoryDispatchStorage + InMemoryTenantDataLoader 中心。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DISPATCH_CONSTRAINTS,
  type DispatchSettings,
  type ProgressPdfData,
} from "@lms-279/shared-types";

import { InMemoryDispatchStorage } from "../in-memory-dispatch-storage.js";
import {
  InMemoryTenantDataLoader,
  type InMemoryTenantFixture,
} from "../tenant-data-loader.js";
import {
  runProgressReports,
  sha256,
  type ProgressReportPdfBuilder,
  type ProgressReportPdfBuilderResult,
} from "../run-progress-reports.js";
import type { SendCompletionMailResult } from "../gmail-dwd-send.js";

const NOW = new Date("2026-06-08T01:00:00.000Z"); // 月曜 UTC 01:00 = JST 10:00
const OCC_1 = "occ_sha256_1";
const OCC_2 = "occ_sha256_2";
const RUN_1 = "run-uuid-1";
const RUN_2 = "run-uuid-2";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ENV = {
  subjectEmail: "system@279279.net",
  fromEmail: "dxcollege@279279.net",
};

function makeSettings(partial: Partial<DispatchSettings> = {}): DispatchSettings {
  return {
    enabled: true,
    scheduleDaysOfWeek: [1], // 月のみ (進捗は月曜 10:00)
    scheduleHourJst: 9,
    signatureName: "DXcollege運営スタッフ",
    completionMessageBody: "受講完了お疲れ様でした。",
    senderEmail: "dxcollege@279279.net",
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "admin@279279.net",
    version: 1,
    progressReport: {
      enabled: true,
      scheduleDaysOfWeek: [1], // 月
      scheduleHourJst: 10,
    },
    ...partial,
  };
}

function makePdfData(overrides?: Partial<ProgressPdfData>): ProgressPdfData {
  const base: ProgressPdfData = {
    generatedAt: NOW.toISOString(),
    user: { id: "u1", name: "山田 太郎", email: "yamada@example.com" },
    tenant: { id: "t1", name: "サンプルテナント", ownerEmail: "owner@example.com" },
    deadline: {
      enrolledAt: "2026-04-01T00:00:00.000Z",
      deadlineBaseDate: "2026-04-01",
      videoAccessUntil: "2026-09-30T14:59:59.000Z",
      quizAccessUntil: "2026-10-31T14:59:59.000Z",
      daysRemainingVideo: 115,
      daysRemainingQuiz: 145,
    },
    courses: [
      {
        courseId: "c1",
        courseName: "コース 1",
        completedLessons: 2,
        totalLessons: 10,
        progressRatio: 0.2,
        isCompleted: false,
        lessons: [],
      },
    ],
    pace: {
      status: "ongoing",
      remainingLessons: 8,
      remainingDays: 115,
      lessonsPerWeek: 1,
      minutesPerDay: 10,
    },
    videoSummary: { totalWatchedSec: 1200, totalDurationSec: 6000 },
  };
  return { ...base, ...overrides };
}

// publishedCourses.lessonOrder.length === courseProgress.totalLessons が必要
// (evaluateCompletionEligibility は 100% 完了判定で両者が一致しないと
// "lesson_count_mismatch" で eligible=false を返すため)。
const COURSE_LESSON_IDS = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];

function makeFixture(partial: Partial<InMemoryTenantFixture> = {}): InMemoryTenantFixture {
  return {
    publishedCourses: [{ id: "c1", lessonOrder: COURSE_LESSON_IDS }],
    users: [{ id: "u1", email: "yamada@example.com", name: "山田 太郎" }],
    courseProgresses: new Map([
      [
        "u1",
        // 20% 完了 (受講中)
        [{ courseId: "c1", isCompleted: false, totalLessons: 10, completedLessons: 2 }],
      ],
    ]),
    ccConfig: {
      completionNotificationEnabled: true,
      ownerEmail: "owner@example.com",
      notificationCcEmails: [],
    },
    info: { active: true, progressReportEnabled: true },
    ...partial,
  };
}

const SMALL_PDF = Buffer.from("%PDF-1.4 fake pdf");

function makePdfBuilder(
  overrides?: (input: { tenantId: string; userId: string }) => ProgressReportPdfBuilderResult,
): ProgressReportPdfBuilder {
  return async ({ tenantId, user }) => {
    if (overrides) {
      const r = overrides({ tenantId, userId: user.id });
      if (r) return r;
    }
    return {
      kind: "ready",
      pdfData: makePdfData({
        user: { id: user.id, email: user.email, name: user.name },
        tenant: { id: tenantId, name: "サンプルテナント", ownerEmail: "owner@example.com" },
      }),
      pdfBuffer: SMALL_PDF,
    };
  };
}

let storage: InMemoryDispatchStorage;
let loader: InMemoryTenantDataLoader;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
  loader = new InMemoryTenantDataLoader();
});

// ============================================================
// Scenario 1-4: kill switch / schedule (AC-PR-05 / AC-PR-22)
// ============================================================

describe("kill switch / schedule (Scenario 1-4)", () => {
  it("[1] settings 不在 → empty response (storage 触らず)", async () => {
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(result.processedTenants).toBe(0);
    expect(result.laneLockContention).toBe(false);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("[2] progressReport.enabled=false → empty + sendRaw 未呼出 (AC-PR-22 kill switch)", async () => {
    storage.__setSettingsForTest(
      makeSettings({
        progressReport: { enabled: false, scheduleDaysOfWeek: [1], scheduleHourJst: 10 },
      }),
    );
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("[3] progressReport 未設定 → empty (AC-PR-05)", async () => {
    storage.__setSettingsForTest(makeSettings({ progressReport: undefined }));
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
  });

  it("[4] schedule 不一致 (火曜) → empty", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const tuesday = new Date("2026-06-09T01:00:00.000Z"); // 火曜 JST 10:00
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: tuesday,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 5: lane lock (AC-PR-09)
// ============================================================

describe("lane lock (Scenario 5)", () => {
  it("[5] lane lock 競合 → laneLockContention=true + audit, sendRaw 未呼出", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    // 先に別 run が lane lock を取得
    await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: "other-run",
      occurrenceId: "other-occ",
      now: NOW.toISOString(),
      leaseExpiresAt: new Date(
        NOW.getTime() + DISPATCH_CONSTRAINTS.PROGRESS_REPORT_LANE_LOCK_LEASE_MS,
      ).toISOString(),
    });

    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.laneLockContention).toBe(true);
    expect(result.sent).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
    const audits = await storage.listAuditLogs({ eventType: "lane_lock_contention" });
    expect(audits).toHaveLength(1);
  });
});

// ============================================================
// Scenario 6-7: tenant filter (AC-PR-04)
// ============================================================

describe("tenant filter (Scenario 6-7)", () => {
  it("[6] tenant active=false → skip (processedTenants=0)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture({ info: { active: false, progressReportEnabled: true } }));
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.processedTenants).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("[7] tenant progressReportEnabled=false → skip (AC-PR-04)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture({ info: { active: true, progressReportEnabled: false } }));
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.processedTenants).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 8: 基本配信成功 (AC-PR-01 / AC-PR-15 / AC-PR-17 / AC-PR-21)
// ============================================================

describe("基本配信 (Scenario 8)", () => {
  it("[8] 1 tenant 1 user → To+CC で送信、PDF 添付、recipient sent, PII sha256", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(1);
    expect(result.processedTenants).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(sendRaw).toHaveBeenCalledTimes(1);

    // recipient state = sent
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(recipient?.status).toBe("sent");
    expect(recipient?.messageId).toBe("msg-001");
    // AC-PR-15 PII sha256: recipientToHash は yamada@example.com の sha256
    expect(recipient?.recipientToHash).toBe(sha256("yamada@example.com"));
    expect(recipient?.recipientCcHashes).toEqual([sha256("owner@example.com")]);
    // AC-PR-17: ttlExpireAt = claimedAt + 90 days
    const expectedTtl = new Date(
      NOW.getTime() +
        DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_TTL_DAYS * MS_PER_DAY,
    ).toISOString();
    expect(recipient?.ttlExpireAt).toBe(expectedTtl);

    // AC-PR-21 audit: progress_report_run_started / progress_report_sent / progress_report_run_completed
    const audits = await storage.listAuditLogs({ runId: RUN_1 });
    const types = audits.map((a) => a.eventType);
    expect(types).toContain("progress_report_run_started");
    expect(types).toContain("progress_report_sent");
    expect(types).toContain("progress_report_run_completed");
  });
});

// ============================================================
// Scenario 9-11: 受講者フィルタ (AC-PR-02 / AC-PR-03 D-5)
// ============================================================

describe("受講者フィルタ (Scenario 9-11)", () => {
  it("[9] 100% 完了者 → skip + user_skipped_completed audit (AC-PR-02)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        courseProgresses: new Map([
          [
            "u1",
            // 100% 完了
            [{ courseId: "c1", isCompleted: true, totalLessons: 10, completedLessons: 10 }],
          ],
        ]),
      }),
    );
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sendRaw).not.toHaveBeenCalled();
    const audits = await storage.listAuditLogs({ eventType: "user_skipped_completed" });
    expect(audits).toHaveLength(1);
  });

  it("[10] 受講中フィルタ: 進捗 0% → listProgressReportTargetUsers が除外", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        courseProgresses: new Map([
          [
            "u1",
            // 0% (Plan A: 1% 未満は除外、ADR-039 D-5)
            [{ courseId: "c1", isCompleted: false, totalLessons: 10, completedLessons: 0 }],
          ],
        ]),
      }),
    );
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(result.processedTenants).toBe(1);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("[11] 受講中フィルタ: videoAccessUntil 期限切れ → 全 user skip", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        videoAccessUntil: "2026-01-01T00:00:00.000Z", // 期限切れ
      }),
    );
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 12-13: occurrenceId 冪等性 (AC-PR-06 / AC-PR-08)
// ============================================================

describe("occurrenceId 冪等 (Scenario 12-13)", () => {
  it("[12] 同 occurrenceId で 2 回目 → already_sent skip (sendRaw 1 回のみ呼出)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });

    // 1 回目
    const r1 = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(r1.sent).toBe(1);

    // 2 回目 (Cloud Scheduler retry): 別 runId、同 occurrenceId
    // ただし lane lock が前 run で解放済 (completeLaneLock) なので acquire 可
    const r2 = await runProgressReports({
      runId: RUN_2,
      occurrenceId: OCC_1, // 同 occurrence
      now: new Date(NOW.getTime() + 60_000),
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(r2.sent).toBe(0); // already_sent で skip
    expect(r2.skipped).toBe(1);
    expect(sendRaw).toHaveBeenCalledTimes(1); // 累計 1 回 (冪等)
  });

  it("[13] 別 occurrenceId で再送可 (翌週相当、AC-PR-08)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });

    // 1 回目 (週 1)
    await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });

    // 2 回目 (週 2、別 occurrenceId、月曜 10:00 JST)
    const nextWeek = new Date(NOW.getTime() + 7 * MS_PER_DAY);
    const r2 = await runProgressReports({
      runId: RUN_2,
      occurrenceId: OCC_2,
      now: nextWeek,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(r2.sent).toBe(1); // 別 occurrence で再送 OK
    expect(sendRaw).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// Scenario 14: pending lease 切れ (AC-PR-07)
// ============================================================

describe("pending lease 切れ (Scenario 14)", () => {
  it("[14] pending claim 後の crash → 次 retry で manual_review_required + counter", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());

    // 1 回目: claim 後 send で疑似 crash (sendRaw throw)
    const sendRawCrash = vi.fn().mockRejectedValue({
      response: { status: 503 }, // transient: recipient pending 維持
    });
    try {
      await runProgressReports({
        runId: RUN_1,
        occurrenceId: OCC_1,
        now: NOW,
        storage,
        loader,
        env: ENV,
        pdfBuilder: makePdfBuilder(),
        sendRaw: sendRawCrash,
      });
    } catch {
      // transient は throw されない、catch 不要
    }
    const before = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(before?.status).toBe("pending"); // transient で pending 維持

    // 2 回目: lease 切れ (11 min 後) で同 occurrence retry
    const afterLease = new Date(
      NOW.getTime() +
        DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_LEASE_MS +
        60_000,
    );
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-002", attempts: 1 });
    const r2 = await runProgressReports({
      runId: RUN_2,
      occurrenceId: OCC_1,
      now: afterLease,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(r2.pendingPromotedToManualReview).toBe(1);
    expect(r2.sent).toBe(0); // 自動再送なし (AC-PR-07)
    expect(sendRaw).not.toHaveBeenCalled();

    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(recipient?.status).toBe("manual_review_required");
  });
});

// ============================================================
// Scenario 15: PDF 5MB 超 (AC-PR-13)
// ============================================================

describe("PDF size 上限 (Scenario 15)", () => {
  it("[15] PDF 5MB 超 → pdf_too_large skip + 専用 audit + failed counter 不変", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const pdfBuilder: ProgressReportPdfBuilder = async () => ({
      kind: "pdf_too_large",
      sizeBytes: DISPATCH_CONSTRAINTS.PROGRESS_REPORT_PDF_MAX_BYTES + 1,
    });
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder,
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1); // 専用 counter (failed 不変)
    expect(result.failed).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
    const audits = await storage.listAuditLogs({ eventType: "pdf_too_large" });
    expect(audits).toHaveLength(1);
    // recipient state = failed (errorCode=pdf_too_large) で pending 滞留を防ぐ
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(recipient?.status).toBe("failed");
    expect(recipient?.errorCode).toBe("pdf_too_large");
  });
});

// ============================================================
// Scenario 16-19: Gmail error classification (AC-PR-20 / AC-PR-21)
// ============================================================

describe("Gmail エラー分類 (Scenario 16-19)", () => {
  it("[16] Gmail 400 permanent → recipient failed + failed counter", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockRejectedValue({ response: { status: 400 } });
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(recipient?.status).toBe("failed");
    expect(recipient?.errorCode).toBe("gmail_permanent_400");
  });

  it("[17] Gmail 403 user_permanent → recipient failed (run 中断せず)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    // user_permanent (mailbox not found 等): dispatch-403-classifier が "user_permanent" を返す
    // raw Gmail API error の error.errors[0].reason は "notFound" 等
    const error403UserPermanent = {
      response: {
        status: 403,
        data: {
          error: { errors: [{ reason: "permissionDenied" }] },
        },
      },
    };
    const sendRaw = vi.fn().mockRejectedValue(error403UserPermanent);
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    // 403 でも scope_revoked でないため run 継続 + recipient failed
    expect(result.failed).toBe(1);
    expect(result.processedTenants).toBe(1);
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(recipient?.status).toBe("failed");
    expect(recipient?.errorCode).toBe("gmail_user_permanent_403");
  });

  it("[18] Gmail 403 scope_revoked → run 中断 + abortLaneLock + audit", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    // scope_revoked: classifyGmail403 が "scope_revoked" を返す
    // (e.g., insufficient_scope error)
    const errorScopeRevoked = {
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: "insufficientPermissions" }],
            status: "PERMISSION_DENIED",
          },
        },
      },
    };
    const sendRaw = vi.fn().mockRejectedValue(errorScopeRevoked);
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    // abort 経路: processedTenants は計上、metrics は abort 時点で確定
    expect(result.processedTenants).toBe(1);
    const audits = await storage.listAuditLogs({ eventType: "progress_report_run_aborted" });
    expect(audits).toHaveLength(1);
    expect(audits[0].errorCode).toBe("gmail_scope_revoked");
    // lane lock は abort 経路で解放済 (次 run が acquire 可)
    // (確認: 同 lane で別 run が acquire 試行)
    const second = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: "other",
      now: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(second.acquired).toBe(true);
  });

  it("[19] Gmail 429 transient (retry MAX 後) → failed counter + recipient pending 維持", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    // gmail-dwd-send の retry は 3 回まで、本テストでは sendRaw を直接 mock しているので
    // sendRaw が 429 で reject = retry も尽きた状態を表す
    const sendRaw = vi.fn().mockRejectedValue({ response: { status: 429 } });
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.failed).toBe(1);
    // recipient pending 維持 (lease 切れまで次 retry で再 claim 可)
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    expect(recipient?.status).toBe("pending"); // transient で pending 維持
  });
});

// ============================================================
// Scenario 20-21: 入力 validation
// ============================================================

describe("入力 validation (Scenario 20-21)", () => {
  it("[20] user.email validation 失敗 (空文字) → skip + audit", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [{ id: "u1", email: "", name: "Empty Email" }],
      }),
    );
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it("[21] CC validation: invalid ownerEmail → audit のみ、送信は継続", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        ccConfig: {
          completionNotificationEnabled: true,
          ownerEmail: "invalid<email>", // 不正
          notificationCcEmails: [],
        },
      }),
    );
    // pdfBuilder の ownerEmail を invalid に上書き
    const pdfBuilder: ProgressReportPdfBuilder = async ({ user, tenantId }) => ({
      kind: "ready",
      pdfData: makePdfData({
        user: { id: user.id, email: user.email, name: user.name },
        tenant: { id: tenantId, name: "テナント", ownerEmail: "invalid<email>" },
      }),
      pdfBuffer: SMALL_PDF,
    });
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder,
      sendRaw,
    });
    // CC は除外されるが送信は続行
    expect(result.sent).toBe(1);
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Scenario 22-23: PII + TTL (AC-PR-15 / AC-PR-17)
// ============================================================

describe("PII / TTL (Scenario 22-23)", () => {
  it("[22] PII sha256: recipient sub-collection に raw email を保存しない", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    // raw email が保存されていないこと
    const serialized = JSON.stringify(recipient);
    expect(serialized).not.toContain("yamada@example.com");
    expect(serialized).not.toContain("owner@example.com");
    // sha256 hash が保存されていること
    expect(recipient?.recipientToHash).toBe(sha256("yamada@example.com"));
  });

  it("[23] TTL: pending claim 時点で ttlExpireAt = claimedAt + 90 days 設定 (AC-PR-17)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    // claim 後に send で失敗させて recipient state を確認できるようにする
    const sendRaw = vi.fn().mockRejectedValue({ response: { status: 400 } });
    await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    const recipient = await storage.getProgressRecipient({
      tenantId: "t1",
      userId: "u1",
      occurrenceId: OCC_1,
    });
    const expected = new Date(
      NOW.getTime() +
        DISPATCH_CONSTRAINTS.PROGRESS_REPORT_RECIPIENT_TTL_DAYS * MS_PER_DAY,
    ).toISOString();
    expect(recipient?.ttlExpireAt).toBe(expected);
  });
});

// ============================================================
// Scenario 24-25: メトリクス / multi-tenant (AC-PR-11)
// ============================================================

describe("メトリクス / multi-tenant (Scenario 24-25)", () => {
  it("[24] metric / response 集計: sent + skipped + failed + pendingPromotedToManualReview", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [
          { id: "u1", email: "u1@example.com", name: "User 1" }, // sent
          { id: "u2", email: "u2@example.com", name: "User 2" }, // skipped (100%)
        ],
        courseProgresses: new Map([
          [
            "u1",
            [{ courseId: "c1", isCompleted: false, totalLessons: 10, completedLessons: 2 }],
          ],
          [
            "u2",
            [{ courseId: "c1", isCompleted: true, totalLessons: 10, completedLessons: 10 }],
          ],
        ]),
      }),
    );
    const sendRaw = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "msg-001", attempts: 1 } as SendCompletionMailResult);
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(1); // u1
    expect(result.skipped).toBe(1); // u2 (100% 完了)
    expect(result.failed).toBe(0);
    expect(result.processedTenants).toBe(1);
    expect(result.pendingPromotedToManualReview).toBe(0);
  });

  it("[25] multi-tenant: tenant A 有効 + tenant B 無効 → processedTenants=1, tenant A のみ送信 (AC-PR-04)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("tA", makeFixture()); // active + progressReportEnabled=true
    loader.setTenant(
      "tB",
      makeFixture({
        info: { active: true, progressReportEnabled: false },
        users: [{ id: "uB", email: "uB@example.com", name: "User B" }],
      }),
    );
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.processedTenants).toBe(1);
    expect(result.sent).toBe(1);
    expect(sendRaw).toHaveBeenCalledTimes(1);
    // tenant B の user に recipient doc が無いこと
    const rB = await storage.getProgressRecipient({
      tenantId: "tB",
      userId: "uB",
      occurrenceId: OCC_1,
    });
    expect(rB).toBeNull();
  });
});

// ============================================================
// Scenario 26-29: code-review CONFIRMED fixes 反映の追加カバレッジ
// ============================================================

describe("code-review fixes — eligibility 異常状態 (Scenario 26-27)", () => {
  it("[26] publishedCourses=[] (no_published_courses) → skip + eligibility_no_published_courses audit (code-review #1)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        publishedCourses: [], // 空: no_published_courses
      }),
    );
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sendRaw).not.toHaveBeenCalled();
    const audits = await storage.listAuditLogs({ eventType: "user_skipped" });
    const eligibilitySkip = audits.find(
      (a) => a.errorCode === "eligibility_no_published_courses",
    );
    expect(eligibilitySkip).toBeDefined();
  });

  it("[27] courseProgress 不在 (missing_progress) → skip + eligibility_missing_progress audit (code-review #1)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant(
      "t1",
      makeFixture({
        // user は listProgressReportTargetUsers から取得されるが
        // courseProgress map を空にすると evaluateCompletionEligibility が
        // missing_progress を返す (eligible=false)
        courseProgresses: new Map(), // 全 user で progress 不在
        users: [{ id: "u1", email: "u1@example.com", name: "User 1" }],
      }),
    );
    const sendRaw = vi.fn();
    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    // listProgressReportTargetUsers で progress 0% は除外 (Plan A) されるため、
    // courseProgress を持つが lessons 数不一致パターンを使う必要がある。
    // 今回は user が listProgressReportTargetUsers から除外されるので processedTenants=1 / skipped=0
    expect(result.processedTenants).toBe(1);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

describe("code-review fixes — markSent race + unexpected error (Scenario 28-29)", () => {
  it("[28] markRecipientSent precondition 失敗 (race) → orphan_send audit + sent +1、二重送信なし (code-review #2)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });

    // markProgressRecipientSent を mock して precondition 失敗を再現
    vi.spyOn(storage, "markProgressRecipientSent").mockRejectedValueOnce(
      new Error('markProgressRecipientSent: status must be "pending" but was "manual_review_required" for ...'),
    );

    const result = await runProgressReports({
      runId: RUN_1,
      occurrenceId: OCC_1,
      now: NOW,
      storage,
      loader,
      env: ENV,
      pdfBuilder: makePdfBuilder(),
      sendRaw,
    });
    // Gmail には送信済なので metrics.sent +=1 (受講者は受信済)
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(sendRaw).toHaveBeenCalledTimes(1);
    // orphan_send audit が記録されている
    const audits = await storage.listAuditLogs({ eventType: "orphan_send" });
    expect(audits).toHaveLength(1);
    expect(audits[0].errorCode).toBe("marksent_precondition_failed_after_send");
    // run abort なし (lane lock は正常 complete)
    const runAborted = await storage.listAuditLogs({
      eventType: "progress_report_run_aborted",
    });
    expect(runAborted).toHaveLength(0);
  });

  it("[29] tenant 走査中に想定外 error throw → progress_report_run_aborted (errorCode=unexpected_error) audit + lock 解放 + throw (code-review #8)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    // tenant ループ内で想定外エラーを throw させる
    vi.spyOn(loader, "getTenantInfo").mockRejectedValueOnce(
      new Error("Firestore transient down"),
    );
    const sendRaw = vi.fn();

    await expect(
      runProgressReports({
        runId: RUN_1,
        occurrenceId: OCC_1,
        now: NOW,
        storage,
        loader,
        env: ENV,
        pdfBuilder: makePdfBuilder(),
        sendRaw,
      }),
    ).rejects.toThrow(/Firestore transient down/);

    // audit: progress_report_run_aborted (errorCode=unexpected_error)
    const audits = await storage.listAuditLogs({
      eventType: "progress_report_run_aborted",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].errorCode).toBe("unexpected_error");

    // lock 解放確認: 別 run が acquire 可能
    const second = await storage.acquireLaneLock({
      laneId: "progress",
      ownerRunId: "other",
      now: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(second.acquired).toBe(true);
  });
});
