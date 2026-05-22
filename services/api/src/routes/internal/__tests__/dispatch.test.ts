/**
 * routes/internal/dispatch の Integration テスト (Phase 4 endpoint).
 *
 * 設計仕様書 §3.1 / AC-30 / NFR-2 に対応。
 *
 * 観点:
 *   - 認証失敗 (OIDC token なし / audience 不一致) → 401
 *   - 正常 path: 200 + RunCompletionNotificationsResponse
 *   - kill switch (settings disabled): 200 + empty
 *   - runId / now 注入で deterministic 結果
 *   - storage / loader / sendMail は DI で test 用に差し替え可
 *   - 想定外エラー (storage throw 等) → 500 + ADR-010 形式
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { DispatchSettings } from "@lms-279/shared-types";

import { createInternalDispatchRouter } from "../dispatch.js";
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
  SendCompletionMailInput,
  SendCompletionMailResult,
} from "../../../services/dispatch/gmail-dwd-send.js";

type SendMailFn = (
  input: SendCompletionMailInput,
) => Promise<SendCompletionMailResult>;

const AUDIENCE = "https://api.example.com/internal/dispatch";
const NOW = new Date("2026-05-25T00:00:00.000Z"); // 月曜 JST 09:00
const RUN_ID = "fixed-run-id";

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
    scheduleDaysOfWeek: [1, 4],
    scheduleHourJst: 9,
    signatureName: "DXcollege運営スタッフ",
    completionMessageBody: "受講お疲れ様でした。",
    senderEmail: "dxcollege@279279.net",
    updatedAt: "2026-05-20T00:00:00.000Z",
    updatedBy: "admin@279279.net",
    version: 1,
    ...partial,
  };
}

function makeFixture(): InMemoryTenantFixture {
  return {
    publishedCourses: [{ id: "c1", lessonOrder: ["l1", "l2", "l3"] }],
    users: [{ id: "user-1", email: "u1@example.com", name: "User One" }],
    courseProgresses: new Map([
      [
        "user-1",
        [{ courseId: "c1", isCompleted: true, totalLessons: 3, completedLessons: 3 }],
      ],
    ]),
    ccConfig: {
      completionNotificationEnabled: true,
      ownerEmail: "owner@a.com",
      notificationCcEmails: [],
    },
  };
}

let storage: InMemoryDispatchStorage;
let loader: InMemoryTenantDataLoader;

beforeEach(() => {
  storage = new InMemoryDispatchStorage();
  loader = new InMemoryTenantDataLoader();
});

function makeApp(opts: {
  verifier: OidcTokenVerifier;
  sendMail?: SendMailFn;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v2/internal",
    createInternalDispatchRouter({
      expectedAudience: AUDIENCE,
      verifier: opts.verifier,
      storage,
      loader,
      env: { subjectEmail: "system@279279.net", fromEmail: "dxcollege@279279.net" },
      sendMail: opts.sendMail,
      runIdGenerator: () => RUN_ID,
      nowProvider: () => NOW,
    }),
  );
  return app;
}

describe("認証", () => {
  it("OIDC token なし → 401 + missing_authorization", async () => {
    const app = makeApp({ verifier: makeSuccessVerifier() });
    const res = await request(app).post(
      "/api/v2/internal/dispatch/run-completion-notifications",
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });

  it("verifier が throw → 401", async () => {
    const app = makeApp({ verifier: makeFailureVerifier() });
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-completion-notifications")
      .set("Authorization", "Bearer some.token");
    expect(res.status).toBe(401);
  });
});

describe("正常 path", () => {
  beforeEach(() => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("tenantA", makeFixture());
  });

  it("100% 完了 user 1 件 → 200 + sent=1", async () => {
    const sendMail = vi
      .fn()
      .mockResolvedValue({ messageId: "msg-001", attempts: 1 });
    const app = makeApp({ verifier: makeSuccessVerifier(), sendMail });

    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-completion-notifications")
      .set("Authorization", "Bearer valid.token");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runId: RUN_ID,
      processedTenants: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
      manualReviewRequired: 0,
    });
  });

  it("settings disabled → 200 + empty response", async () => {
    storage.__setSettingsForTest(makeSettings({ enabled: false }));
    const sendMail = vi.fn();
    const app = makeApp({ verifier: makeSuccessVerifier(), sendMail });

    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-completion-notifications")
      .set("Authorization", "Bearer valid.token");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: 0, processedTenants: 0 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("settings なし → 200 + empty response (Phase 7 初期化前)", async () => {
    // 別ストレージ (settings 未設定) で実行
    const freshStorage = new InMemoryDispatchStorage();
    const app2 = express();
    app2.use(express.json());
    app2.use(
      "/api/v2/internal",
      createInternalDispatchRouter({
        expectedAudience: AUDIENCE,
        verifier: makeSuccessVerifier(),
        storage: freshStorage,
        loader,
        env: { subjectEmail: "s@x.com", fromEmail: "f@x.com" },
        runIdGenerator: () => RUN_ID,
        nowProvider: () => NOW,
      }),
    );

    const res = await request(app2)
      .post("/api/v2/internal/dispatch/run-completion-notifications")
      .set("Authorization", "Bearer valid.token");
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
  });
});

describe("想定外エラー", () => {
  it("storage 自体が throw (acquireRunLock 障害) → 500", async () => {
    storage.__setSettingsForTest(makeSettings());
    loader.setTenant("tenantA", makeFixture());
    // vi.spyOn でテスト終了時の自動 restore を効かせる (safe-refactor MEDIUM-3 反映)
    const spy = vi
      .spyOn(storage, "acquireRunLock")
      .mockRejectedValue(new Error("Firestore unavailable"));

    const app = makeApp({
      verifier: makeSuccessVerifier(),
      sendMail: vi.fn(),
    });
    const res = await request(app)
      .post("/api/v2/internal/dispatch/run-completion-notifications")
      .set("Authorization", "Bearer valid.token");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("dispatch_unexpected_error");
    spy.mockRestore();
  });
});
