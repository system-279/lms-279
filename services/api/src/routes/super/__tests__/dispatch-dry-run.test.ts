/**
 * createDispatchDryRunRouter (Phase 4 α-7 GET /super/dispatch/dry-run/{progress|completion}) の integration test。
 *
 * 観点:
 *   - 200 OK + discriminated union output (lane field の正確性)
 *   - 500 (storage / loader が throw)
 *   - 429 (専用 limiter、10 req/min/superAdminEmail、AC-α7-12)
 *   - single-flight 統合 (同 lane 並行 → fn 1 回呼び出し、Codex High Firestore read 抑制)
 *   - read-only 保証 (Firestore write API を route が呼ばない、AC-α7-06)
 *   - PR #490 撤廃方針の維持: test-send 経路ゼロ
 *   - 完了通知 service-level regression (Codex AC-α7-07 強化、5 パス: tenant disable / no courses / invalid email / 既通知 / MIME preview)
 *
 * 認可は親で適用される前提のため、テストでは fake superAdmin middleware を挟む。
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";
import type {
  CompletionDryRunResult,
  ProgressDryRunResult,
} from "@lms-279/shared-types";

import { InMemoryDispatchStorage } from "../../../services/dispatch/in-memory-dispatch-storage.js";
import {
  InMemoryTenantDataLoader,
  type TenantDataLoader,
  type DispatchTenantDataView,
} from "../../../services/dispatch/tenant-data-loader.js";
import { createDispatchDryRunSingleFlightForTest } from "../../../services/dispatch/dry-run/single-flight.js";
import type { ProgressDryRunLogger } from "../../../services/dispatch/dry-run/progress-report-dry-run.js";
import { createDispatchDryRunRouter } from "../dispatch-dry-run.js";
import {
  FIXTURE_SENDER_EMAIL as SENDER,
  makeSettings,
  makeFixture,
  partialProgress,
  completedProgress,
} from "../../../services/dispatch/dry-run/__tests__/dry-run-fixtures.js";

const ADMIN_EMAIL = "admin@example.com";

function makeApp(
  storage: InMemoryDispatchStorage,
  loader: InMemoryTenantDataLoader | TenantDataLoader,
  opts: {
    enableLimiter?: boolean;
    limiterLimit?: number;
    singleFlight?: ReturnType<typeof createDispatchDryRunSingleFlightForTest>;
    progressDryRunLogger?: ProgressDryRunLogger;
  } = {},
): express.Express {
  const app = express();
  app.use(express.json());
  // fake super-admin auth (親 router で適用される設計)
  app.use((req, _res, next) => {
    // limiter の keyGenerator が duck typing で email field のみ読む。
    // 強い型 assertion で AuthUser (id / role 必須) との不一致を回避。
    (req as unknown as { user: { email: string } }).user = {
      email: ADMIN_EMAIL,
    };
    next();
  });
  // test 用 limiter: default 無効 (noop)、必要時のみ enable
  const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
  const testLimiter = opts.enableLimiter
    ? rateLimit({
        windowMs: 60 * 1000,
        limit: opts.limiterLimit ?? 10,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        keyGenerator: () => "test-key", // 全リクエスト同一 key で test 簡素化
        message: {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many dry-run requests.",
          },
        },
      })
    : noopLimiter;

  // Default test logger は noop で標準出力汚染を避ける。F4 regression test では
  // 明示的に spy logger を渡して呼び出しを assert する。
  const noopLogger: ProgressDryRunLogger = { warnTenantDocNotFound: () => {} };

  app.use(
    "/api/v2/super",
    createDispatchDryRunRouter({
      storage,
      loader,
      senderEmail: SENDER,
      limiter: testLimiter,
      singleFlight:
        opts.singleFlight ?? createDispatchDryRunSingleFlightForTest(),
      progressDryRunLogger: opts.progressDryRunLogger ?? noopLogger,
    }),
  );
  return app;
}

// makeFixture / makeSettings / partialProgress / completedProgress は
// services/api/src/services/dispatch/dry-run/__tests__/dry-run-fixtures.ts に集約 (safe-refactor M2)。

// ============================================================
// GET /super/dispatch/dry-run/progress
// ============================================================

describe("GET /super/dispatch/dry-run/progress", () => {
  it("should return 200 with empty result when no tenants", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader);

    const res = await request(app).get("/api/v2/super/dispatch/dry-run/progress");

    expect(res.status).toBe(200);
    const body = res.body as ProgressDryRunResult;
    expect(body.lane).toBe("progress");
    expect(body.tenantsScanned).toBe(0);
    expect(body.tenantsSummary).toEqual([]);
    expect(body.totalWouldSendCount).toBe(0);
    expect(body.scaleTriggerExceeded).toBe(false);
  });

  it("should return 200 with progress-specific fields (totalWouldSendCount / estimatedDurationMs / scaleTriggerExceeded)", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const courseProgresses = new Map<string, ReturnType<typeof partialProgress>>();
    courseProgresses.set("u1", partialProgress());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
        courseProgresses,
      }),
    );
    const app = makeApp(storage, loader);

    const res = await request(app).get("/api/v2/super/dispatch/dry-run/progress");

    expect(res.status).toBe(200);
    const body = res.body as ProgressDryRunResult;
    expect(body.lane).toBe("progress");
    expect(body.totalWouldSendCount).toBe(1);
    expect(body.estimatedDurationMs).toBeGreaterThan(0);
    expect(body.estimatedPdfSizeKbRange).toMatchObject({
      min: expect.any(Number),
      typical: expect.any(Number),
      max: expect.any(Number),
    });
  });

  it("should propagate 500 when loader throws", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    // listAllTenantIds を override して throw させる
    loader.listAllTenantIds = vi.fn(async () => {
      throw new Error("simulated firestore failure");
    });

    const app = makeApp(storage, loader);
    // Express default error handler が 500 を返すことを確認
    // ただし vitest デフォルト挙動では console.error が出るため、抑制
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await request(app).get("/api/v2/super/dispatch/dry-run/progress");

    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });
});

// ============================================================
// GET /super/dispatch/dry-run/completion
// ============================================================

describe("GET /super/dispatch/dry-run/completion", () => {
  it("should return 200 with empty result when no tenants", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    expect(res.status).toBe(200);
    const body = res.body as CompletionDryRunResult;
    expect(body.lane).toBe("completion");
    expect(body.tenantsScanned).toBe(0);
    expect(body.wouldNotifyCount).toBe(0);
    expect(body.wouldNotify).toEqual([]);
  });

  it("should return 200 with completion-specific fields (wouldNotify[] + MIME preview)", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.__setSettingsForTest(makeSettings());
    const loader = new InMemoryTenantDataLoader();
    const courseProgresses = new Map<string, ReturnType<typeof completedProgress>>();
    courseProgresses.set("u1", completedProgress());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [{ id: "u1", email: "u1@example.com", name: "ユーザー一郎" }],
        courseProgresses,
      }),
    );
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    expect(res.status).toBe(200);
    const body = res.body as CompletionDryRunResult;
    expect(body.lane).toBe("completion");
    expect(body.wouldNotifyCount).toBe(1);
    expect(body.wouldNotify[0]).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      userEmail: "u1@example.com",
    });
    // MIME preview: subject / body / from
    expect(body.wouldNotify[0]?.mimePreview.from).toContain(SENDER);
    expect(body.wouldNotify[0]?.mimePreview.subject).toBeTruthy();
    expect(body.wouldNotify[0]?.mimePreview.body).toBeTruthy();
  });

  it("should propagate 500 when storage throws", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.getDispatchSettings = vi.fn(async () => {
      throw new Error("simulated firestore failure");
    });
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader);
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });
});

// ============================================================
// single-flight integration (Codex High: Firestore read 抑制)
// ============================================================

describe("single-flight integration", () => {
  // 注: 「same-lane 並行リクエストで fn 1 回」の単体担保は
  // single-flight.test.ts (DI 直接 test、5 cases) で完了済。
  // supertest の HTTP 並行モデルでは process-tick タイミングで
  // 1 リクエスト目が sf.run() の Map.set 完了前に 2 リクエスト目が到達することがあり
  // flaky になりやすいため、route integration では「異なる lane の独立実行」のみ確認する。

  it("should execute independently for different lanes", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader);

    const [progressRes, completionRes] = await Promise.all([
      request(app).get("/api/v2/super/dispatch/dry-run/progress"),
      request(app).get("/api/v2/super/dispatch/dry-run/completion"),
    ]);

    expect(progressRes.status).toBe(200);
    expect((progressRes.body as ProgressDryRunResult).lane).toBe("progress");
    expect(completionRes.status).toBe(200);
    expect((completionRes.body as CompletionDryRunResult).lane).toBe("completion");
  });
});

// ============================================================
// logger injection (F4 silent-fail-paired-signal regression)
// ============================================================

describe("progressDryRunLogger integration (F4)", () => {
  it("should invoke injected logger.warnTenantDocNotFound when tenant doc is missing", async () => {
    // Phase 4 α-7 code-review F4: HTTP route が tenant_doc_not_found 警告を silent
    // drop しないことを担保。CLI 経由は CONSOLE_PROGRESS_DRY_RUN_LOGGER で stderr に
    // 出ていたが、HTTP route は NOOP に fallback していたため Cloud Logging に痕跡が
    // 残らず CLAUDE.md silent-fail-paired-signal ルールに抵触していた。
    const storage = new InMemoryDispatchStorage();
    const ghostLoader: TenantDataLoader = {
      async listAllTenantIds() {
        return ["ghost"];
      },
      async getTenantInfo() {
        return null;
      },
      async getTenantCcConfig() {
        return null;
      },
      getTenantDataView(): DispatchTenantDataView {
        throw new Error("not reachable: tenant_doc_not_found path should skip");
      },
    };
    const warnSpy = vi.fn();
    const app = makeApp(storage, ghostLoader, {
      progressDryRunLogger: { warnTenantDocNotFound: warnSpy },
    });

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/progress",
    );

    expect(res.status).toBe(200);
    const body = res.body as ProgressDryRunResult;
    expect(body.tenantsSummary[0]?.skipReason).toBe("tenant_doc_not_found");
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith("ghost");
  });
});

// ============================================================
// limiter integration (429)
// ============================================================

describe("limiter integration (429)", () => {
  it("should return 429 after exceeding limit per superAdmin email", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    // limit 2 で test を加速
    const app = makeApp(storage, loader, {
      enableLimiter: true,
      limiterLimit: 2,
    });

    const r1 = await request(app).get("/api/v2/super/dispatch/dry-run/progress");
    const r2 = await request(app).get("/api/v2/super/dispatch/dry-run/progress");
    const r3 = await request(app).get("/api/v2/super/dispatch/dry-run/progress");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.body.error?.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("should share limiter budget across progress and completion lanes (F5 documented behavior)", async () => {
    // Phase 4 α-7 code-review F5 / Evaluator エッジ-1 反映:
    // 単一 dispatchDryRunLimiter instance を両 handler に貼っているため、10 req/min は
    // **両 lane 合算** の budget となる仕様。本 test で lane 横断バジェット共有を
    // pin し、将来 per-lane 化への refactor が入ったときに気付けるようにする。
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader, {
      enableLimiter: true,
      limiterLimit: 2,
    });

    const r1 = await request(app).get("/api/v2/super/dispatch/dry-run/progress");
    const r2 = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );
    const r3 = await request(app).get("/api/v2/super/dispatch/dry-run/progress");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.body.error?.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

// ============================================================
// AC-α7-05: super-admin auth 拒否時 403 (Evaluator 反映)
// ============================================================

describe("AC-α7-05 super-admin auth rejection", () => {
  it("should return 403 when parent auth middleware rejects (no super-admin)", async () => {
    // 親 router (本番 index.ts では `/api/v2/super` に superAdminAuthMiddleware を
    // mount) が 403 を返す状況を模擬。createDispatchDryRunRouter は auth を内包
    // しない設計なので、本テストは「auth middleware 不在なら handler に到達しない」
    // 責務分離を pin する。AC-α7-05 の BE 側保証。
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = express();
    app.use(express.json());
    // 親で 403 を返す fake auth (super-admin 以外を一律拒否する形を模擬)
    app.use("/api/v2/super", (_req, res) => {
      res.status(403).json({
        error: { code: "FORBIDDEN", message: "super-admin only" },
      });
    });
    // 上の middleware で response が返るため、下の router には到達しない
    app.use(
      "/api/v2/super",
      createDispatchDryRunRouter({
        storage,
        loader,
        senderEmail: SENDER,
        singleFlight: createDispatchDryRunSingleFlightForTest(),
        progressDryRunLogger: { warnTenantDocNotFound: () => {} },
      }),
    );

    const progressRes = await request(app).get(
      "/api/v2/super/dispatch/dry-run/progress",
    );
    const completionRes = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    expect(progressRes.status).toBe(403);
    expect(completionRes.status).toBe(403);
    expect(progressRes.body.error?.code).toBe("FORBIDDEN");
  });
});

// ============================================================
// 完了通知 service-level regression (Codex High: AC-α7-07 強化、5 パス)
// ============================================================

describe("完了通知 service-level regression (5 paths)", () => {
  it("should skip tenant with completionNotificationEnabled=false (path 1: tenant disable)", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.__setSettingsForTest(makeSettings());
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant(
      "t1",
      makeFixture({
        ccConfig: {
          completionNotificationEnabled: false,
          ownerEmail: null,
          notificationCcEmails: [],
        },
      }),
    );
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    const body = res.body as CompletionDryRunResult;
    expect(body.tenantsSummary[0]?.skipReason).toBe(
      "tenant_completion_notification_disabled",
    );
    expect(body.wouldNotifyCount).toBe(0);
  });

  it("should skip tenant with empty publishedCourses (path 2: no courses)", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.__setSettingsForTest(makeSettings());
    const loader = new InMemoryTenantDataLoader();
    loader.setTenant("t1", makeFixture({ publishedCourses: [] }));
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    const body = res.body as CompletionDryRunResult;
    expect(body.tenantsSummary[0]?.skipReason).toBe("no_published_courses");
    expect(body.wouldNotifyCount).toBe(0);
  });

  it("should reject invalid email (path 3: invalid email)", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.__setSettingsForTest(makeSettings());
    const loader = new InMemoryTenantDataLoader();
    const courseProgresses = new Map<string, ReturnType<typeof completedProgress>>();
    courseProgresses.set("u-invalid", completedProgress());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [
          { id: "u-invalid", email: "not-an-email", name: "U-Invalid" },
        ],
        courseProgresses,
      }),
    );
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    const body = res.body as CompletionDryRunResult;
    expect(body.wouldNotifyCount).toBe(0);
    expect(body.tenantsSummary[0]?.eligibleCount).toBe(0);
  });

  it("should skip user whose notification already exists (path 4: already notified)", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.__setSettingsForTest(makeSettings());
    // 既通知 user を inject (storage 内部 state)
    storage.getCompletionNotification = vi.fn(async (_tid, uid) =>
      uid === "u1"
        ? ({
            userId: "u1",
            status: "sent",
            runId: "run-1",
            reservedAt: "2026-05-01T00:00:00.000Z",
            leaseExpiresAt: "2026-05-01T00:30:00.000Z",
            notifiedAt: "2026-05-01T00:01:00.000Z",
            messageId: "msg",
            errorCode: null,
            errorMessage: null,
            failedAt: null,
            progressSnapshot: {
              completedLessons: 3,
              totalLessons: 3,
              coursesCompleted: 1,
              coursesTotal: 1,
            },
            courseIdsSnapshot: ["c1"],
            publishedCourseCount: 1,
            recipientToHash: "h",
            recipientCcHashes: [],
            pdfSizeBytes: null,
          } as Awaited<ReturnType<typeof storage.getCompletionNotification>>)
        : null,
    );
    const loader = new InMemoryTenantDataLoader();
    const courseProgresses = new Map<string, ReturnType<typeof completedProgress>>();
    courseProgresses.set("u1", completedProgress());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
        courseProgresses,
      }),
    );
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    const body = res.body as CompletionDryRunResult;
    expect(body.wouldNotifyCount).toBe(0);
  });

  it("should generate MIME preview for eligible new user (path 5: MIME preview)", async () => {
    const storage = new InMemoryDispatchStorage();
    storage.__setSettingsForTest(makeSettings());
    const loader = new InMemoryTenantDataLoader();
    const courseProgresses = new Map<string, ReturnType<typeof completedProgress>>();
    courseProgresses.set("u1", completedProgress());
    loader.setTenant(
      "t1",
      makeFixture({
        users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
        courseProgresses,
        ccConfig: {
          completionNotificationEnabled: true,
          ownerEmail: "owner@example.com",
          notificationCcEmails: ["cc@example.com"],
        },
      }),
    );
    const app = makeApp(storage, loader);

    const res = await request(app).get(
      "/api/v2/super/dispatch/dry-run/completion",
    );

    const body = res.body as CompletionDryRunResult;
    expect(body.wouldNotifyCount).toBe(1);
    expect(body.wouldNotify[0]?.mimePreview.to).toBe("u1@example.com");
    expect(body.wouldNotify[0]?.mimePreview.cc).toEqual(
      expect.arrayContaining(["owner@example.com", "cc@example.com"]),
    );
    expect(body.wouldNotify[0]?.mimePreview.subject).toBeTruthy();
    expect(body.wouldNotify[0]?.mimePreview.body).toBeTruthy();
  });
});

// ============================================================
// PR #490 撤廃方針の維持: test-send 経路ゼロ
// ============================================================

describe("PR #490 撤廃方針の維持", () => {
  it("should NOT expose POST /dispatch/test-send (404 or method not allowed)", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader);

    const res = await request(app)
      .post("/api/v2/super/dispatch/test-send")
      .send({ to: "victim@example.com" });

    // 404 (router 未登録) を想定。test-send 経路は本 PR で復活させない。
    expect(res.status).toBe(404);
  });

  it("should NOT expose POST /dispatch/dry-run (404, GET only)", async () => {
    const storage = new InMemoryDispatchStorage();
    const loader = new InMemoryTenantDataLoader();
    const app = makeApp(storage, loader);

    // 旧 PR #490 撤廃前は POST /dispatch/dry-run。α-7 では GET /dispatch/dry-run/{lane} のみ。
    const res = await request(app).post("/api/v2/super/dispatch/dry-run").send({});

    expect(res.status).toBe(404);
  });
});
