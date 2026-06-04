/**
 * progress-report-dry-run service module の unit test (Phase 4 α-7 A1)。
 *
 * 観点:
 *   - skip 理由ごとの動作 (tenant_not_active / progress_report_disabled /
 *     no_published_courses / tenant_doc_not_found)
 *   - 内訳カウンタ (candidateCount / invalidEmailCount / completedCount / wouldSendCount)
 *   - 集計 (totalWouldSendCount / totalCcCount / estimatedDurationMs / scaleTriggerExceeded)
 *   - settings snapshot 反映
 *   - logger DI (default noop / 注入時 call)
 *
 * 既存 CLI (scripts/progress-report-dry-run-cli.ts) の振る舞いを 1:1 維持する
 * regression test の役割も兼ねる。
 */

import { describe, it, expect, vi } from "vitest";

import { InMemoryDispatchStorage } from "../../in-memory-dispatch-storage.js";
import {
  InMemoryTenantDataLoader,
  type TenantDataLoader,
  type DispatchTenantDataView,
} from "../../tenant-data-loader.js";
import {
  runProgressReportDryRun,
  type ProgressDryRunLogger,
  AVG_PER_USER_MS,
  USER_CONCURRENCY,
  SCALE_TRIGGER_THRESHOLD,
  PDF_SIZE_KB_RANGE,
} from "../progress-report-dry-run.js";
import {
  FIXTURE_NOW as NOW,
  makeSettings,
  makeFixture,
  partialProgress,
  completedProgress,
} from "./dry-run-fixtures.js";

// ============================================================
// tests
// ============================================================

describe("runProgressReportDryRun", () => {
  describe("no tenants", () => {
    it("should return empty summary with totalWouldSendCount=0", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsScanned).toBe(0);
      expect(result.tenantsSummary).toEqual([]);
      expect(result.totalWouldSendCount).toBe(0);
      expect(result.totalCcCount).toBe(0);
    });
  });

  describe("settings snapshot", () => {
    it("should return settingsLoaded=false and snapshot=null when settings missing", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      // 明示的に null に設定 (default は null だが、テストの意図を明示)
      storage.__setSettingsForTest(null);

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.settingsLoaded).toBe(false);
      expect(result.settingsSnapshot).toBeNull();
    });

    it("should populate settingsSnapshot from progressReport sub-config when settings present", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      storage.__setSettingsForTest(
        makeSettings({
          progressReport: {
            enabled: true,
            scheduleDaysOfWeek: [2, 5],
            scheduleHourJst: 14,
          },
        }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.settingsLoaded).toBe(true);
      expect(result.settingsSnapshot).toEqual({
        progressReportEnabled: true,
        scheduleDaysOfWeek: [2, 5],
        scheduleHourJst: 14,
        signatureName: "DXcollege運営スタッフ",
      });
    });
  });

  describe("skip reasons", () => {
    it("should skip with reason=tenant_not_active", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      loader.setTenant(
        "t1",
        makeFixture({ info: { active: false, progressReportEnabled: true } }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary).toHaveLength(1);
      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "t1",
        skipped: true,
        skipReason: "tenant_not_active",
        wouldSendCount: 0,
      });
    });

    it("should skip with reason=progress_report_disabled", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      loader.setTenant(
        "t1",
        makeFixture({ info: { active: true, progressReportEnabled: false } }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "t1",
        skipped: true,
        skipReason: "progress_report_disabled",
      });
    });

    it("should skip with reason=no_published_courses", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      loader.setTenant("t1", makeFixture({ publishedCourses: [] }));

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "t1",
        skipped: true,
        skipReason: "no_published_courses",
      });
    });

    it("should skip with reason=tenant_doc_not_found and call logger when getTenantInfo returns null", async () => {
      const storage = new InMemoryDispatchStorage();
      const warnSpy = vi.fn();
      const logger: ProgressDryRunLogger = {
        warnTenantDocNotFound: warnSpy,
      };
      // 専用 mock: listAllTenantIds で出るが getTenantInfo は null
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
          throw new Error("not reachable: tenant_doc_not_found path should skip before dataView");
        },
      };

      const result = await runProgressReportDryRun({
        storage,
        loader: ghostLoader,
        now: NOW,
        logger,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "ghost",
        skipped: true,
        skipReason: "tenant_doc_not_found",
      });
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith("ghost");
    });
  });

  describe("count breakdown (candidate / invalid / completed / would-send)", () => {
    it("should count valid + partial-progress user as wouldSendCount=1", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<
        string,
        ReturnType<typeof partialProgress>
      >();
      courseProgresses.set("u1", partialProgress());
      loader.setTenant(
        "t1",
        makeFixture({
          users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
          courseProgresses,
        }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "t1",
        skipped: false,
        candidateCount: 1,
        invalidEmailCount: 0,
        completedCount: 0,
        wouldSendCount: 1,
      });
      expect(result.totalWouldSendCount).toBe(1);
    });

    it("should count invalid email as invalidEmailCount=1 (not wouldSendCount)", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof partialProgress>>();
      courseProgresses.set("u1", partialProgress());
      loader.setTenant(
        "t1",
        makeFixture({
          users: [{ id: "u1", email: "not-an-email", name: "U1" }],
          courseProgresses,
        }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        candidateCount: 1,
        invalidEmailCount: 1,
        completedCount: 0,
        wouldSendCount: 0,
      });
    });

    it("should count 100% completed user as completedCount=1 (not wouldSendCount)", async () => {
      const storage = new InMemoryDispatchStorage();
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

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        candidateCount: 1,
        invalidEmailCount: 0,
        completedCount: 1,
        ineligibleCount: 0,
        wouldSendCount: 0,
      });
    });

    it("should count user with missing courseProgress as ineligibleCount=1 (not wouldSendCount, F1 regression)", async () => {
      // 進捗 user 既出 + 一部 course の courseProgress doc 不在 →
      // evaluateCompletionEligibility は {eligible: false, reason: "missing_progress"}
      // を返す。本番 processProgressUser は reason !== "not_completed" を skip するため、
      // dry-run も ineligibleCount に計上して wouldSendCount overestimate を防ぐ
      // (Phase 4 α-7 code-review F1)。
      // ※ リアルシナリオ: ユーザーが c1 を完了した後に管理者が c2 を新規 publish
      //    したケース。listProgressReportTargetUsers は ratio>=1% で候補化、
      //    evaluateCompletionEligibility は publishedCourses 順走査で c1 (完了) →
      //    c2 (progress doc 不在) で `missing_progress` reason を返す。
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<
        string,
        { courseId: string; isCompleted: boolean; totalLessons: number; completedLessons: number }[]
      >();
      courseProgresses.set("u1", [
        { courseId: "c1", isCompleted: true, totalLessons: 3, completedLessons: 3 },
      ]);
      loader.setTenant(
        "t1",
        makeFixture({
          publishedCourses: [
            { id: "c1", lessonOrder: ["l1", "l2", "l3"] },
            { id: "c2", lessonOrder: ["l1", "l2", "l3"] },
          ],
          users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
          courseProgresses,
        }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        candidateCount: 1,
        invalidEmailCount: 0,
        completedCount: 0,
        ineligibleCount: 1,
        wouldSendCount: 0,
      });
      expect(result.totalWouldSendCount).toBe(0);
    });

    it("should count user with lesson_count_mismatch as ineligibleCount=1 (not wouldSendCount, F1 regression)", async () => {
      // isCompleted:true だが totalLessons (2) !== course.lessonOrder.length (3)
      // → eligibility = {eligible: false, reason: "lesson_count_mismatch"}
      // 本番 processProgressUser は skip 扱い、dry-run も ineligibleCount に算入する。
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<
        string,
        { courseId: string; isCompleted: boolean; totalLessons: number; completedLessons: number }[]
      >();
      courseProgresses.set("u1", [
        { courseId: "c1", isCompleted: true, totalLessons: 2, completedLessons: 2 },
      ]);
      loader.setTenant(
        "t1",
        makeFixture({
          users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
          courseProgresses,
        }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.tenantsSummary[0]).toMatchObject({
        candidateCount: 1,
        ineligibleCount: 1,
        wouldSendCount: 0,
      });
    });
  });

  describe("CC config + totalCcCount", () => {
    it("should populate ccCount from validated + deduped notificationCcEmails", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof partialProgress>>();
      courseProgresses.set("u1", partialProgress());
      loader.setTenant(
        "t1",
        makeFixture({
          users: [{ id: "u1", email: "u1@example.com", name: "U1" }],
          courseProgresses,
          ccConfig: {
            completionNotificationEnabled: true,
            ownerEmail: "owner@example.com",
            notificationCcEmails: ["cc1@example.com", "cc2@example.com"],
          },
        }),
      );

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      // owner + 2 cc = 3 valid (dedup 後)
      expect(result.tenantsSummary[0]?.ccCount).toBe(3);
      // wouldSendCount=1 * ccCount=3 = 3
      expect(result.totalCcCount).toBe(3);
    });
  });

  describe("scale trigger + estimated duration", () => {
    it("should set scaleTriggerExceeded=false when totalWouldSendCount <= threshold", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof partialProgress>>();
      const users: { id: string; email: string; name: string }[] = [];
      for (let i = 0; i < SCALE_TRIGGER_THRESHOLD; i++) {
        const uid = `u${i}`;
        users.push({ id: uid, email: `${uid}@example.com`, name: uid });
        courseProgresses.set(uid, partialProgress());
      }
      loader.setTenant("t1", makeFixture({ users, courseProgresses }));

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.totalWouldSendCount).toBe(SCALE_TRIGGER_THRESHOLD);
      expect(result.scaleTriggerExceeded).toBe(false);
    });

    it("should set scaleTriggerExceeded=true when totalWouldSendCount > threshold", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof partialProgress>>();
      const users: { id: string; email: string; name: string }[] = [];
      const targetCount = SCALE_TRIGGER_THRESHOLD + 1;
      for (let i = 0; i < targetCount; i++) {
        const uid = `u${i}`;
        users.push({ id: uid, email: `${uid}@example.com`, name: uid });
        courseProgresses.set(uid, partialProgress());
      }
      loader.setTenant("t1", makeFixture({ users, courseProgresses }));

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.totalWouldSendCount).toBe(targetCount);
      expect(result.scaleTriggerExceeded).toBe(true);
    });

    it("should calculate estimatedDurationMs = ceil(N / concurrency) * AVG", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof partialProgress>>();
      const users: { id: string; email: string; name: string }[] = [];
      // 8 users → ceil(8/8) = 1 batch → 2000ms
      for (let i = 0; i < USER_CONCURRENCY; i++) {
        const uid = `u${i}`;
        users.push({ id: uid, email: `${uid}@example.com`, name: uid });
        courseProgresses.set(uid, partialProgress());
      }
      loader.setTenant("t1", makeFixture({ users, courseProgresses }));

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.totalWouldSendCount).toBe(USER_CONCURRENCY);
      expect(result.estimatedDurationMs).toBe(AVG_PER_USER_MS);
    });
  });

  describe("output invariants", () => {
    it("should always include PDF_SIZE_KB_RANGE constant", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.estimatedPdfSizeKbRange).toEqual(PDF_SIZE_KB_RANGE);
    });

    it("should serialize evaluatedAt as ISO string from injected now", async () => {
      const storage = new InMemoryDispatchStorage();
      const loader = new InMemoryTenantDataLoader();

      const result = await runProgressReportDryRun({
        storage,
        loader,
        now: NOW,
      });

      expect(result.evaluatedAt).toBe(NOW.toISOString());
    });
  });

  describe("logger DI", () => {
    it("should default to noop logger when none injected (no console call for tenant_doc_not_found)", async () => {
      const storage = new InMemoryDispatchStorage();
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
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
          throw new Error("not reachable");
        },
      };

      await runProgressReportDryRun({
        storage,
        loader: ghostLoader,
        now: NOW,
        // logger 未指定 → NOOP_LOGGER
      });

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
