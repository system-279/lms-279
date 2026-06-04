/**
 * completion-notification-dry-run service module の unit test (Phase 4 α-7 A2)。
 *
 * Codex 高優先指摘 (impl-plan AC-α7-07 強化) 反映:
 *   - 既通知ユーザー除外
 *   - tenant disable
 *   - invalid email reject
 *   - no published courses
 *   - MIME preview 生成 (subject / body / from / cc)
 *
 * 既存 CLI (scripts/dispatch-dry-run-cli.ts) の振る舞いを 1:1 維持する
 * regression test の役割も兼ねる。
 */

import { describe, it, expect } from "vitest";
import type { DispatchSettings, CompletionNotification } from "@lms-279/shared-types";

import { InMemoryTenantDataLoader } from "../../tenant-data-loader.js";
import {
  runCompletionNotificationDryRun,
  DEFAULT_SIGNATURE,
  DEFAULT_BODY,
  type RunCompletionNotificationDryRunInput,
} from "../completion-notification-dry-run.js";
import {
  FIXTURE_NOW as NOW,
  FIXTURE_SENDER_EMAIL as SENDER_EMAIL,
  makeSettings,
  makeFixture,
  partialProgress,
  completedProgress,
} from "./dry-run-fixtures.js";

/**
 * test 用 storage stub。`getCompletionNotification` を inject 可能にし、
 * 既通知ユーザーの skip 経路を test しやすくする。
 *
 * `Pick<DispatchStorage, "getDispatchSettings" | "getCompletionNotification">` の
 * 最小 API のみ実装 (read-only 担保)。
 */
class TestDryRunStorage {
  constructor(
    private readonly settings: DispatchSettings | null,
    private readonly existingNotifications = new Map<string, CompletionNotification>(),
  ) {}

  async getDispatchSettings(): Promise<DispatchSettings | null> {
    return this.settings;
  }

  async getCompletionNotification(
    tenantId: string,
    userId: string,
  ): Promise<CompletionNotification | null> {
    return this.existingNotifications.get(`${tenantId}::${userId}`) ?? null;
  }
}

function makeStorageWithExisting(
  settings: DispatchSettings | null,
  existing: Array<{ tenantId: string; userId: string; notification: CompletionNotification }>,
) {
  const map = new Map<string, CompletionNotification>();
  for (const e of existing) {
    map.set(`${e.tenantId}::${e.userId}`, e.notification);
  }
  return new TestDryRunStorage(settings, map);
}

function defaultInput(
  overrides: Partial<RunCompletionNotificationDryRunInput> = {},
): RunCompletionNotificationDryRunInput {
  return {
    storage: new TestDryRunStorage(null),
    loader: new InMemoryTenantDataLoader(),
    senderEmail: SENDER_EMAIL,
    now: NOW,
    ...overrides,
  };
}

// ============================================================
// tests
// ============================================================

describe("runCompletionNotificationDryRun", () => {
  describe("no tenants", () => {
    it("should return empty tenantsSummary and wouldNotifyCount=0", async () => {
      const result = await runCompletionNotificationDryRun(defaultInput());

      expect(result.tenantsScanned).toBe(0);
      expect(result.tenantsSummary).toEqual([]);
      expect(result.wouldNotifyCount).toBe(0);
      expect(result.wouldNotify).toEqual([]);
    });
  });

  describe("settings snapshot", () => {
    it("should return settingsLoaded=false and snapshot=null when settings missing", async () => {
      const result = await runCompletionNotificationDryRun(defaultInput());

      expect(result.settingsLoaded).toBe(false);
      expect(result.settingsSnapshot).toBeNull();
    });

    it("should populate snapshot from settings (including completionMessageBodyLength)", async () => {
      const settings = makeSettings({
        completionMessageBody: "テスト本文 12 文字",
      });
      const result = await runCompletionNotificationDryRun(
        defaultInput({ storage: new TestDryRunStorage(settings) }),
      );

      expect(result.settingsLoaded).toBe(true);
      expect(result.settingsSnapshot).toMatchObject({
        enabled: true,
        scheduleDaysOfWeek: [1, 4],
        scheduleHourJst: 9,
        signatureName: "DXcollege運営スタッフ",
        completionMessageBodyLength: "テスト本文 12 文字".length,
      });
    });

    it("should return completionMessageBodyLength=null when settings.completionMessageBody is undefined (F3 regression)", async () => {
      // Phase 4 α-7 code-review F3: PutDispatchSettingsRequest が patch semantics で
      // 全 field optional になり、Firestore に partial doc が残ると storage 経由で
      // `completionMessageBody: undefined` が返る。旧実装は `.length` で TypeError を
      // throw して 500 → cutover preview が UI で死ぬ。null 許容で graceful fallback。
      const settings = makeSettings();
      // 型をすり抜けて undefined を強制 (storage roundtrip 経由のパーシャル状態を模倣)
      delete (settings as { completionMessageBody?: string }).completionMessageBody;

      const result = await runCompletionNotificationDryRun(
        defaultInput({ storage: new TestDryRunStorage(settings) }),
      );

      expect(result.settingsLoaded).toBe(true);
      expect(result.settingsSnapshot?.completionMessageBodyLength).toBeNull();
      // signatureName 等の他フィールドは引き続き取れる (no throw)
      expect(result.settingsSnapshot?.signatureName).toBe("DXcollege運営スタッフ");
    });
  });

  describe("skip reasons (Codex AC-α7-07: 5 パス regression 強化)", () => {
    it("should skip with reason=tenant_completion_notification_disabled when ccConfig.completionNotificationEnabled=false", async () => {
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

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "t1",
        skipped: true,
        skipReason: "tenant_completion_notification_disabled",
        eligibleCount: 0,
      });
      expect(result.wouldNotifyCount).toBe(0);
    });

    it("should skip with reason=tenant_completion_notification_disabled when ccConfig is null", async () => {
      const loader = new InMemoryTenantDataLoader();
      loader.setTenant("t1", makeFixture({ ccConfig: null }));

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      expect(result.tenantsSummary[0]?.skipReason).toBe(
        "tenant_completion_notification_disabled",
      );
    });

    it("should skip with reason=no_published_courses", async () => {
      const loader = new InMemoryTenantDataLoader();
      loader.setTenant("t1", makeFixture({ publishedCourses: [] }));

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      expect(result.tenantsSummary[0]).toMatchObject({
        tenantId: "t1",
        skipped: true,
        skipReason: "no_published_courses",
      });
    });

    it("should reject invalid email and expose invalidEmailCount=1 (F8 regression)", async () => {
      // Phase 4 α-7 code-review F8: 進捗レーンとの対称性回復のため、完了通知レーンでも
      // invalidEmailCount を tenantsSummary で公開する。malformed email user は
      // eligibleCount に含めず invalidEmailCount に独立計上する。
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof completedProgress>>();
      courseProgresses.set("u-invalid", completedProgress());
      loader.setTenant(
        "t1",
        makeFixture({
          users: [{ id: "u-invalid", email: "not-an-email", name: "U-Invalid" }],
          courseProgresses,
        }),
      );

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      expect(result.tenantsSummary[0]).toMatchObject({
        skipped: false,
        usersScanned: 1,
        eligibleCount: 0,
        invalidEmailCount: 1,
      });
      expect(result.wouldNotifyCount).toBe(0);
    });

    it("should skip when CompletionNotification already exists (any status)", async () => {
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

      const sentNotification: CompletionNotification = {
        userId: "u1",
        status: "sent",
        runId: "run-1",
        reservedAt: "2026-05-01T00:00:00.000Z",
        leaseExpiresAt: "2026-05-01T00:30:00.000Z",
        notifiedAt: "2026-05-01T00:01:00.000Z",
        messageId: "msg-1",
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
        recipientToHash: "sha256-abc",
        recipientCcHashes: [],
        pdfSizeBytes: null,
      };
      const storage = makeStorageWithExisting(null, [
        { tenantId: "t1", userId: "u1", notification: sentNotification },
      ]);

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader, storage }),
      );

      expect(result.tenantsSummary[0]).toMatchObject({
        skipped: false,
        usersScanned: 1,
        eligibleCount: 0, // 既送信は eligibleCount に含めない
      });
      expect(result.wouldNotifyCount).toBe(0);
    });
  });

  describe("eligible target generation + MIME preview", () => {
    it("should include 100% completed user in wouldNotify with valid MIME preview", async () => {
      const loader = new InMemoryTenantDataLoader();
      const courseProgresses = new Map<string, ReturnType<typeof completedProgress>>();
      courseProgresses.set("u1", completedProgress());
      loader.setTenant(
        "t1",
        makeFixture({
          users: [{ id: "u1", email: "u1@example.com", name: "ユーザー一郎" }],
          courseProgresses,
          ccConfig: {
            completionNotificationEnabled: true,
            ownerEmail: "owner@example.com",
            notificationCcEmails: ["cc1@example.com"],
          },
        }),
      );
      const settings = makeSettings();
      const storage = new TestDryRunStorage(settings);

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader, storage }),
      );

      expect(result.wouldNotifyCount).toBe(1);
      const target = result.wouldNotify[0];
      expect(target).toMatchObject({
        tenantId: "t1",
        userId: "u1",
        userEmail: "u1@example.com",
        userName: "ユーザー一郎",
        courseIdsSnapshot: ["c1"],
      });
      expect(target?.mimePreview.from).toBe(
        `DXcollege運営スタッフ <${SENDER_EMAIL}>`,
      );
      expect(target?.mimePreview.to).toBe("u1@example.com");
      expect(target?.mimePreview.cc).toEqual(
        expect.arrayContaining(["owner@example.com", "cc1@example.com"]),
      );
      expect(typeof target?.mimePreview.subject).toBe("string");
      expect(target?.mimePreview.subject.length).toBeGreaterThan(0);
      expect(typeof target?.mimePreview.body).toBe("string");
      expect(target?.mimePreview.body.length).toBeGreaterThan(0);
    });

    it("should NOT include partial-progress (< 100%) user in wouldNotify", async () => {
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

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      expect(result.wouldNotifyCount).toBe(0);
      expect(result.tenantsSummary[0]?.eligibleCount).toBe(0);
    });

    it("should use DEFAULT_SIGNATURE and DEFAULT_BODY in MIME when settings is null", async () => {
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

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      expect(result.wouldNotifyCount).toBe(1);
      const target = result.wouldNotify[0];
      expect(target?.mimePreview.from).toBe(
        `${DEFAULT_SIGNATURE} <${SENDER_EMAIL}>`,
      );
      // DEFAULT_BODY が MIME body のどこかに含まれることを期待
      expect(target?.mimePreview.body.includes(DEFAULT_BODY)).toBe(true);
    });
  });

  describe("CC dedup", () => {
    it("should dedupe ownerEmail and notificationCcEmails (case-insensitive)", async () => {
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
            ownerEmail: "Owner@example.com",
            notificationCcEmails: ["owner@example.com", "cc@example.com"],
          },
        }),
      );

      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader }),
      );

      const cc = result.wouldNotify[0]?.mimePreview.cc ?? [];
      // case-insensitive dedup: Owner@example.com と owner@example.com は 1 件にまとまる
      expect(cc).toHaveLength(2);
    });
  });

  describe("sender email injection", () => {
    it("should use injected senderEmail in MIME preview from field", async () => {
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

      const customSender = "custom-sender@example.org";
      const result = await runCompletionNotificationDryRun(
        defaultInput({ loader, senderEmail: customSender }),
      );

      expect(result.wouldNotify[0]?.mimePreview.from).toContain(customSender);
    });
  });

  describe("output invariants", () => {
    it("should serialize evaluatedAt as ISO string from injected now", async () => {
      const result = await runCompletionNotificationDryRun(defaultInput());

      expect(result.evaluatedAt).toBe(NOW.toISOString());
    });
  });
});
