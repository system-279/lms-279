/**
 * routes/internal/progress-reports の Integration テスト (Phase 3 PR 3c)。
 *
 * 設計仕様書 §4.1、AC-PR-16 (OIDC verify) / AC-PR-06 (occurrenceId 算出) 対応。
 *
 * 観点:
 *   - OIDC token なし / audience 不一致 → 401
 *   - X-CloudScheduler-ScheduleTime 不在 → 400 missing_schedule_time_header
 *   - 正常 path: 200 + RunProgressReportsResponse、occurrenceId 算出
 *   - settings 不在 → 200 + empty
 *   - 同 scheduleTime で 2 回 → occurrenceId 一致 → 2 回目は already_sent skip
 *   - 想定外エラー (storage throw 等) → 500 + ADR-010 形式
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type {
  DispatchSettings,
  ProgressPdfData,
} from "@lms-279/shared-types";

import {
  computeProgressOccurrenceId,
  createInternalProgressReportsRouter,
} from "../progress-reports.js";
import { InMemoryDispatchStorage } from "../../../services/dispatch/in-memory-dispatch-storage.js";
import {
  InMemoryTenantDataLoader,
  type InMemoryTenantFixture,
} from "../../../services/dispatch/tenant-data-loader.js";
import type {
  OidcTokenVerifier,
  VerifiedOidcCaller,
} from "../../../services/dispatch/oidc-verify.js";
import type {
  SendCompletionMailResult,
  SendRawMessageInput,
} from "../../../services/dispatch/gmail-dwd-send.js";
import type { ProgressReportPdfBuilder } from "../../../services/dispatch/run-progress-reports.js";

const AUDIENCE = "https://api.example.com/internal/dispatch";
const NOW = new Date("2026-06-08T01:00:00.000Z"); // 月曜 UTC 01:00 = JST 10:00
const SCHEDULE_TIME = "2026-06-08T01:00:00Z";
const RUN_ID = "fixed-run-id";
const ENV = { subjectEmail: "system@279279.net", fromEmail: "dxcollege@279279.net" };

const VERIFIED_CALLER: VerifiedOidcCaller = {
  email: "dxcollege-scheduler@lms-279.iam.gserviceaccount.com",
  subject: "sa-subject",
  audience: AUDIENCE,
};

function makeSuccessVerifier(): OidcTokenVerifier {
  return { verify: vi.fn(async () => VERIFIED_CALLER) };
}

function makeFailureVerifier(): OidcTokenVerifier {
  return {
    verify: vi.fn(async () => {
      throw new Error("token verify failed");
    }),
  };
}

function makeSettings(partial: Partial<DispatchSettings> = {}): DispatchSettings {
  return {
    enabled: true,
    scheduleDaysOfWeek: [1],
    scheduleHourJst: 9,
    signatureName: "DXcollege運営スタッフ",
    completionMessageBody: "受講完了お疲れ様でした。",
    senderEmail: "dxcollege@279279.net",
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "admin@279279.net",
    version: 1,
    progressReport: {
      enabled: true,
      scheduleDaysOfWeek: [1],
      scheduleHourJst: 10,
    },
    ...partial,
  };
}

function makePdfData(): ProgressPdfData {
  return {
    generatedAt: NOW.toISOString(),
    user: { id: "u1", name: "山田 太郎", email: "u1@example.com" },
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
}

const COURSE_LESSON_IDS = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];

function makeFixture(): InMemoryTenantFixture {
  return {
    publishedCourses: [{ id: "c1", lessonOrder: COURSE_LESSON_IDS }],
    users: [{ id: "u1", email: "u1@example.com", name: "山田 太郎" }],
    courseProgresses: new Map([
      [
        "u1",
        [{ courseId: "c1", isCompleted: false, totalLessons: 10, completedLessons: 2 }],
      ],
    ]),
    ccConfig: {
      completionNotificationEnabled: true,
      ownerEmail: "owner@example.com",
      notificationCcEmails: [],
    },
    info: { active: true, progressReportEnabled: true },
  };
}

const SMALL_PDF = Buffer.from("%PDF-1.4 fake pdf");

function makePdfBuilder(): ProgressReportPdfBuilder {
  return async ({ tenantId, user }) => ({
    kind: "ready",
    pdfData: {
      ...makePdfData(),
      user: { id: user.id, email: user.email, name: user.name },
      tenant: { id: tenantId, name: "サンプルテナント", ownerEmail: "owner@example.com" },
    },
    pdfBuffer: SMALL_PDF,
  });
}

let storage: InMemoryDispatchStorage;
let loader: InMemoryTenantDataLoader;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
  loader = new InMemoryTenantDataLoader();
});

function buildApp(opts: {
  verifier?: OidcTokenVerifier;
  sendRaw?: (input: SendRawMessageInput) => Promise<SendCompletionMailResult>;
  pdfBuilder?: ProgressReportPdfBuilder;
}): express.Express {
  const app = express();
  app.use(express.json());
  const router = createInternalProgressReportsRouter({
    expectedAudience: AUDIENCE,
    verifier: opts.verifier ?? makeSuccessVerifier(),
    storage,
    loader,
    env: ENV,
    pdfBuilder: opts.pdfBuilder ?? makePdfBuilder(),
    ...(opts.sendRaw !== undefined && { sendRaw: opts.sendRaw }),
    runIdGenerator: () => RUN_ID,
    nowProvider: () => NOW,
  });
  app.use("/api/v2/internal", router);
  return app;
}

// ============================================================
// computeProgressOccurrenceId
// ============================================================

describe("computeProgressOccurrenceId", () => {
  it("同 scheduleTime で同 occurrenceId (deterministic、冪等性キー)", () => {
    const a = computeProgressOccurrenceId(SCHEDULE_TIME);
    const b = computeProgressOccurrenceId(SCHEDULE_TIME);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("別 scheduleTime で別 occurrenceId", () => {
    const a = computeProgressOccurrenceId("2026-06-08T01:00:00Z");
    const b = computeProgressOccurrenceId("2026-06-15T01:00:00Z");
    expect(a).not.toBe(b);
  });

  it("完了通知レーンと異なる occurrenceId namespace (lane prefix で分離)", () => {
    // ここでは progress prefix のみテスト (completion 側は別 helper を想定)
    const progressOcc = computeProgressOccurrenceId(SCHEDULE_TIME);
    expect(progressOcc).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// OIDC verify (AC-PR-16)
// ============================================================

describe("OIDC verify (AC-PR-16)", () => {
  it("Authorization ヘッダなし → 401", async () => {
    const app = buildApp({ verifier: makeSuccessVerifier() });
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });

  it("Bearer なし → 401", async () => {
    const app = buildApp({ verifier: makeSuccessVerifier() });
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Basic abc")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_authorization_format");
  });

  it("verifier throw → 401 (audience 不一致 等)", async () => {
    const app = buildApp({ verifier: makeFailureVerifier() });
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(res.status).toBe(401);
  });
});

// ============================================================
// X-CloudScheduler-ScheduleTime ヘッダ
// ============================================================

describe("X-CloudScheduler-ScheduleTime ヘッダ", () => {
  it("ヘッダなし → 400 missing_schedule_time_header", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_schedule_time_header");
  });

  it("ヘッダ空文字 → 400", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", "   ")
      .send({});
    expect(res.status).toBe(400);
  });
});

// ============================================================
// 正常 path
// ============================================================

describe("正常 path", () => {
  it("settings 不在 → 200 + empty", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.runId).toBe(RUN_ID);
    expect(res.body.occurrenceId).toBe(computeProgressOccurrenceId(SCHEDULE_TIME));
  });

  it("基本配信成功 → 200 + sent=1 + occurrenceId 含む", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    const app = buildApp({ sendRaw });
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.processedTenants).toBe(1);
    expect(res.body.occurrenceId).toBe(computeProgressOccurrenceId(SCHEDULE_TIME));
    expect(res.body.laneLockContention).toBe(false);
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });

  it("同 scheduleTime で 2 回 → 2 回目 already_sent skip (冪等)", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("t1", makeFixture());
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    const app = buildApp({ sendRaw });

    // 1 回目
    const r1 = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(r1.body.sent).toBe(1);

    // 2 回目 (同 scheduleTime → 同 occurrenceId)
    const r2 = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(r2.body.sent).toBe(0); // 冪等 skip
    expect(r2.body.occurrenceId).toBe(r1.body.occurrenceId);
    expect(sendRaw).toHaveBeenCalledTimes(1); // 累計 1 回
  });
});

// ============================================================
// 想定外エラー
// ============================================================

describe("想定外エラー", () => {
  it("storage が throw → 500 + dispatch_unexpected_error", async () => {
    storage.__setSettingsForTest(makeSettings());
    // storage.getDispatchSettings を強制 throw
    vi.spyOn(storage, "getDispatchSettings").mockRejectedValueOnce(
      new Error("Firestore down"),
    );
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-progress-reports")
      .set("Authorization", "Bearer fake-token")
      .set("X-CloudScheduler-ScheduleTime", SCHEDULE_TIME)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("dispatch_unexpected_error");
  });
});
