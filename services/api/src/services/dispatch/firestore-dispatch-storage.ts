/**
 * DispatchStorage の Firestore 実装。
 *
 * 設計仕様書 §4.1.1〜4.1.5、§6.2〜6.3、FR-7 改訂 / FR-11 / FR-12 / NFR-3 対応。
 *
 * 関連 ADR:
 *   - ADR-028 (InMemoryDataSource 中心のテスト戦略)
 *   - ADR-034 (PII 最小化)
 *   - rules/production-data-safety.md §1 (sanitizeForUpdate で既存値保護)
 *   - rules/error-handling.md §1 (audit log は best-effort、caller に伝播しない)
 *
 * Phase 7 で wiring され、production では本実装、test では InMemoryDispatchStorage を
 * 切り替えて使用する (factory pattern、`route/internal/dispatch.ts` で DI)。
 *
 * 設計判断:
 *   - reservation / lease 期限切れ降格は runTransaction で atomic に実行
 *     (Codex Critical-1+3: 並列 worker による二重 sent 防止の中核)
 *   - run-lock の "他 running が lease 内" 判定はクエリ → set で行う
 *     (FR-11 は best-effort、per-user reservation が真の安全装置)
 *   - audit log 書き込みは best-effort: Firestore 例外を caller に伝播せず logger.warn のみ
 *     (spec §6.1 「audit_logs 書き込み失敗は警告ログのみ、レスポンスをブロックしない」)
 *   - ISO 8601 string ↔ Firestore Timestamp は本層のみが変換責務を持つ
 *     (caller / interface は全て ISO 8601 string で統一)
 */

import {
  Timestamp,
  type Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import {
  type CompletionNotification,
  type CompletionNotificationStatus,
  type DispatchAuditLog,
  type DispatchLane,
  type DispatchLaneLock,
  type DispatchRun,
  type DispatchRunStatus,
  type DispatchSettings,
  type ProgressReportClaimOutcome,
  type ProgressReportRecipient,
  type ProgressReportRecipientStatus,
  type ReservationOutcome,
} from "@lms-279/shared-types";

import { logger } from "../../utils/logger.js";

import type {
  AbortLaneLockInput,
  AcquireLaneLockInput,
  AcquireLaneLockOutcome,
  AcquireRunLockInput,
  AcquireRunLockOutcome,
  AppendAuditLogInput,
  ClaimProgressRecipientInput,
  CompleteLaneLockInput,
  DispatchStorage,
  GetProgressRecipientInput,
  MarkFailedPermanentInput,
  MarkProgressRecipientFailedInput,
  MarkProgressRecipientSentInput,
  MarkSentInput,
  PromotePendingToManualReviewInput,
  ReserveCompletionNotificationInput,
  UpdateDispatchSettingsInput,
  UpdateDispatchSettingsOutcome,
  UpdateRunStatusInput,
} from "./dispatch-storage.js";

// ============================================================
// Firestore collection paths
// ============================================================

const COLL_SETTINGS = "super_dispatch_settings";
const DOC_SETTINGS_GLOBAL = "global";
const COLL_RUNS = "super_dispatch_runs";
const COLL_AUDIT_LOGS = "super_dispatch_audit_logs";
/** Phase 3 ADR-039 D-4: 配信レーン別の排他 lock */
const COLL_LANE_LOCKS = "super_dispatch_lane_locks";

function completionNotificationsCollection(tenantId: string): string {
  return `tenants/${tenantId}/completion_notifications`;
}

/** Phase 3 ADR-039 D-3: tenants/{tid}/progress_report_sends sub-collection */
function progressReportSendsCollection(tenantId: string): string {
  return `tenants/${tenantId}/progress_report_sends`;
}

/**
 * progress_report_sends の doc id 規則 (occurrenceId__userId)。
 * occurrence 単位の at-most-once attempt を doc id レベルで保証する。
 */
function progressRecipientDocId(occurrenceId: string, userId: string): string {
  return `${occurrenceId}__${userId}`;
}

// ============================================================
// Helpers: Timestamp <-> ISO string
// ============================================================

function isoToTimestamp(iso: string): Timestamp {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO 8601 string: ${iso}`);
  }
  return Timestamp.fromDate(d);
}

/**
 * Firestore Timestamp / Date / null を ISO 文字列に変換。
 *
 * Firestore SDK は Timestamp を返すのが基本だが、emulator や移行データで Date が
 * 混在する可能性に備えて両対応する。null / undefined は null を返す。
 */
function timestampToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(
    `timestampToIso: unsupported value type ${typeof value} (expected Timestamp/Date/string)`,
  );
}

function requireIso(value: unknown, field: string): string {
  const iso = timestampToIso(value);
  if (iso === null) {
    throw new Error(`Required Timestamp field missing: ${field}`);
  }
  return iso;
}

// ============================================================
// Helpers: sanitizeForUpdate (production-data-safety.md §1)
// ============================================================

/**
 * undefined フィールドをオブジェクトから除去し、既存 Firestore 値を保護する。
 *
 * `null` は明示的な値として保持する (例: abortedReason のクリア)。
 * `undefined` は Partial Update のセマンティクス上、既存値保持を意味する。
 */
function sanitizeForUpdate<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

// ============================================================
// Doc converters (Firestore data → typed entity)
// ============================================================

function toDispatchSettings(data: Record<string, unknown>): DispatchSettings {
  // 設計仕様書 §4.1.1 では Firestore doc に senderEmail を保存しない (env DXCOLLEGE_SENDER_EMAIL
  // から読み取り、編集不可)。本層は raw doc を返すのみで、Phase 5 super-admin API レスポンス
  // 層で env からの merge を行う設計 (本層では senderEmail が undefined になりうる)。
  // 現状の Phase 7 では senderEmail を直接消費する code path が無いため、空文字列にフォールバック
  // して下流の type-checker を満たす。Phase 5 で API 経由公開する際は必ず env 値を上書きする。
  return {
    enabled: data.enabled as boolean,
    scheduleDaysOfWeek: data.scheduleDaysOfWeek as number[],
    scheduleHourJst: data.scheduleHourJst as number,
    signatureName: data.signatureName as string,
    completionMessageBody: data.completionMessageBody as string,
    senderEmail: (data.senderEmail as string | undefined) ?? "",
    // Phase 3 (ADR-039 D-1): optional field、未保存 doc では undefined
    ...(data.progressReport !== undefined && {
      progressReport: data.progressReport as DispatchSettings["progressReport"],
    }),
    updatedAt: requireIso(data.updatedAt, "updatedAt"),
    updatedBy: data.updatedBy as string,
    version: data.version as number,
  };
}

function toDispatchRun(data: Record<string, unknown>): DispatchRun {
  return {
    runId: data.runId as string,
    // Phase 3 (ADR-039 D-1): laneId 欠落時 "completion" 扱い (後方互換)
    ...(data.laneId !== undefined && { laneId: data.laneId as DispatchLane }),
    ...(data.occurrenceId !== undefined && {
      occurrenceId: data.occurrenceId as string,
    }),
    triggeredAt: requireIso(data.triggeredAt, "triggeredAt"),
    status: data.status as DispatchRunStatus,
    leaseExpiresAt: requireIso(data.leaseExpiresAt, "leaseExpiresAt"),
    processedTenants: (data.processedTenants as number) ?? 0,
    sent: (data.sent as number) ?? 0,
    skipped: (data.skipped as number) ?? 0,
    failed: (data.failed as number) ?? 0,
    manualReviewRequired: (data.manualReviewRequired as number) ?? 0,
    abortedReason: (data.abortedReason as string | null) ?? null,
    ttlExpireAt: requireIso(data.ttlExpireAt, "ttlExpireAt"),
  };
}

/** Phase 3 ADR-039 D-4: super_dispatch_lane_locks/{laneId} doc → entity */
function toDispatchLaneLock(data: Record<string, unknown>): DispatchLaneLock {
  return {
    laneId: data.laneId as DispatchLane,
    ownerRunId: data.ownerRunId as string,
    ...(data.occurrenceId !== undefined && {
      occurrenceId: data.occurrenceId as string,
    }),
    leaseExpiresAt: requireIso(data.leaseExpiresAt, "leaseExpiresAt"),
    acquiredAt: requireIso(data.acquiredAt, "acquiredAt"),
    updatedAt: requireIso(data.updatedAt, "updatedAt"),
  };
}

/** Phase 3 ADR-039 D-3: progress_report_sends doc → entity */
function toProgressReportRecipient(
  data: Record<string, unknown>,
): ProgressReportRecipient {
  return {
    occurrenceId: data.occurrenceId as string,
    runId: data.runId as string,
    userId: data.userId as string,
    status: data.status as ProgressReportRecipientStatus,
    claimedAt: requireIso(data.claimedAt, "claimedAt"),
    leaseExpiresAt: requireIso(data.leaseExpiresAt, "leaseExpiresAt"),
    sentAt: timestampToIso(data.sentAt),
    messageId: (data.messageId as string | null) ?? null,
    pdfSizeBytes: (data.pdfSizeBytes as number | null) ?? null,
    failedAt: timestampToIso(data.failedAt),
    errorCode: (data.errorCode as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    promotedAt: timestampToIso(data.promotedAt),
    recipientToHash: (data.recipientToHash as string) ?? "",
    recipientCcHashes: (data.recipientCcHashes as string[]) ?? [],
    ttlExpireAt: requireIso(data.ttlExpireAt, "ttlExpireAt"),
  };
}

function toCompletionNotification(
  data: Record<string, unknown>,
): CompletionNotification {
  return {
    userId: data.userId as string,
    status: data.status as CompletionNotificationStatus,
    runId: data.runId as string,
    reservedAt: requireIso(data.reservedAt, "reservedAt"),
    leaseExpiresAt: requireIso(data.leaseExpiresAt, "leaseExpiresAt"),
    notifiedAt: timestampToIso(data.notifiedAt),
    messageId: (data.messageId as string | null) ?? null,
    errorCode: (data.errorCode as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    failedAt: timestampToIso(data.failedAt),
    progressSnapshot: (data.progressSnapshot ?? {
      completedLessons: 0,
      totalLessons: 0,
      coursesCompleted: 0,
      coursesTotal: 0,
    }) as CompletionNotification["progressSnapshot"],
    courseIdsSnapshot: (data.courseIdsSnapshot as string[]) ?? [],
    publishedCourseCount: (data.publishedCourseCount as number) ?? 0,
    recipientToHash: (data.recipientToHash as string) ?? "",
    recipientCcHashes: (data.recipientCcHashes as string[]) ?? [],
    pdfSizeBytes: (data.pdfSizeBytes as number | null) ?? null,
  };
}

function toAuditLog(data: Record<string, unknown>): DispatchAuditLog {
  return {
    auditId: data.auditId as string,
    runId: data.runId as string,
    runStartedAt: requireIso(data.runStartedAt, "runStartedAt"),
    eventType: data.eventType as DispatchAuditLog["eventType"],
    tenantId: (data.tenantId as string | null) ?? null,
    userId: (data.userId as string | null) ?? null,
    errorCode: (data.errorCode as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    durationMs: (data.durationMs as number | null) ?? null,
    createdAt: requireIso(data.createdAt, "createdAt"),
    ttlExpireAt: requireIso(data.ttlExpireAt, "ttlExpireAt"),
  };
}

// ============================================================
// FirestoreDispatchStorage
// ============================================================

export class FirestoreDispatchStorage implements DispatchStorage {
  constructor(private readonly db: Firestore) {}

  // ----- helper: doc refs -----
  private settingsRef(): DocumentReference {
    return this.db
      .collection(COLL_SETTINGS)
      .doc(DOC_SETTINGS_GLOBAL) as unknown as DocumentReference;
  }

  private completionNotificationRef(
    tenantId: string,
    userId: string,
  ): DocumentReference {
    return this.db
      .collection(completionNotificationsCollection(tenantId))
      .doc(userId) as unknown as DocumentReference;
  }

  private runRef(runId: string): DocumentReference {
    return this.db.collection(COLL_RUNS).doc(runId) as unknown as DocumentReference;
  }

  private auditLogRef(auditId: string): DocumentReference {
    return this.db
      .collection(COLL_AUDIT_LOGS)
      .doc(auditId) as unknown as DocumentReference;
  }

  /** Phase 3 ADR-039 D-4: lane lock doc ref */
  private laneLockRef(laneId: DispatchLane): DocumentReference {
    return this.db
      .collection(COLL_LANE_LOCKS)
      .doc(laneId) as unknown as DocumentReference;
  }

  /** Phase 3 ADR-039 D-3: progress recipient doc ref */
  private progressRecipientRef(
    tenantId: string,
    occurrenceId: string,
    userId: string,
  ): DocumentReference {
    return this.db
      .collection(progressReportSendsCollection(tenantId))
      .doc(progressRecipientDocId(occurrenceId, userId)) as unknown as DocumentReference;
  }

  // =====================================================================
  // Settings
  // =====================================================================

  async getDispatchSettings(): Promise<DispatchSettings | null> {
    const snap = (await this.settingsRef().get()) as DocumentSnapshot;
    if (!snap.exists) return null;
    return toDispatchSettings(snap.data() ?? {});
  }

  async updateDispatchSettings(
    input: UpdateDispatchSettingsInput,
  ): Promise<UpdateDispatchSettingsOutcome> {
    const ref = this.settingsRef();
    // read version → 一致判定 → write を runTransaction で atomic に保護 (lost update 防止)
    // Phase 3 ADR-039 HIGH-4: patch semantics で既存 doc あれば undefined field を保持
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      const current = snap.exists ? toDispatchSettings(snap.data() ?? {}) : null;
      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== currentVersion) {
        return {
          updated: false as const,
          reason: "version_conflict" as const,
          current,
        };
      }
      const nextVersion = currentVersion + 1;

      // 既存 doc あり → patch merge (sanitizeForUpdate で undefined 除去、null は通す)
      if (current) {
        const patchData = sanitizeForUpdate({
          enabled: input.enabled,
          scheduleDaysOfWeek: input.scheduleDaysOfWeek,
          scheduleHourJst: input.scheduleHourJst,
          signatureName: input.signatureName,
          completionMessageBody: input.completionMessageBody,
          progressReport: input.progressReport,
          senderEmail: input.senderEmail,
          updatedAt: isoToTimestamp(input.updatedAt),
          updatedBy: input.updatedBy,
          version: nextVersion,
        });
        tx.update(ref, patchData);
        const settings: DispatchSettings = {
          ...current,
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.scheduleDaysOfWeek !== undefined && {
            scheduleDaysOfWeek: input.scheduleDaysOfWeek,
          }),
          ...(input.scheduleHourJst !== undefined && {
            scheduleHourJst: input.scheduleHourJst,
          }),
          ...(input.signatureName !== undefined && {
            signatureName: input.signatureName,
          }),
          ...(input.completionMessageBody !== undefined && {
            completionMessageBody: input.completionMessageBody,
          }),
          ...(input.progressReport !== undefined && {
            progressReport: input.progressReport,
          }),
          ...(input.senderEmail !== undefined && {
            senderEmail: input.senderEmail,
          }),
          updatedAt: input.updatedAt,
          updatedBy: input.updatedBy,
          version: nextVersion,
        };
        return { updated: true as const, settings };
      }

      // 初回 create: 必須 field self-defense check (route 層で validate 済前提)
      if (
        input.enabled === undefined ||
        input.scheduleDaysOfWeek === undefined ||
        input.scheduleHourJst === undefined ||
        input.signatureName === undefined ||
        input.completionMessageBody === undefined ||
        input.senderEmail === undefined
      ) {
        throw new Error(
          "updateDispatchSettings: initial create requires all completion fields + senderEmail; got undefined for required field(s). Route handler must validate before calling.",
        );
      }
      const createData: Record<string, unknown> = {
        enabled: input.enabled,
        scheduleDaysOfWeek: input.scheduleDaysOfWeek,
        scheduleHourJst: input.scheduleHourJst,
        signatureName: input.signatureName,
        completionMessageBody: input.completionMessageBody,
        senderEmail: input.senderEmail,
        ...(input.progressReport !== undefined && {
          progressReport: input.progressReport,
        }),
        updatedAt: isoToTimestamp(input.updatedAt),
        updatedBy: input.updatedBy,
        version: nextVersion,
      };
      tx.set(ref, createData);
      const settings: DispatchSettings = {
        enabled: input.enabled,
        scheduleDaysOfWeek: input.scheduleDaysOfWeek,
        scheduleHourJst: input.scheduleHourJst,
        signatureName: input.signatureName,
        completionMessageBody: input.completionMessageBody,
        senderEmail: input.senderEmail,
        ...(input.progressReport !== undefined && {
          progressReport: input.progressReport,
        }),
        updatedAt: input.updatedAt,
        updatedBy: input.updatedBy,
        version: nextVersion,
      };
      return { updated: true as const, settings };
    });
  }

  // =====================================================================
  // Reservation
  // =====================================================================

  async tryReserveCompletionNotification(
    input: ReserveCompletionNotificationInput,
  ): Promise<ReservationOutcome> {
    const { tenantId, userId, runId, now, leaseExpiresAt } = input;
    const ref = this.completionNotificationRef(tenantId, userId);
    const nowMs = new Date(now).getTime();

    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (snap.exists) {
        const data = (snap.data() ?? {}) as Record<string, unknown>;
        const status = data.status as CompletionNotificationStatus | undefined;
        switch (status) {
          case "sent":
            return { reserved: false, reason: "already_sent" } satisfies ReservationOutcome;
          case "failed_permanent":
            return {
              reserved: false,
              reason: "failed_permanent",
            } satisfies ReservationOutcome;
          case "manual_review_required":
            return {
              reserved: false,
              reason: "manual_review_required",
            } satisfies ReservationOutcome;
          case "reserved": {
            const leaseIso = timestampToIso(data.leaseExpiresAt);
            const leaseMs = leaseIso ? new Date(leaseIso).getTime() : 0;
            if (leaseMs <= nowMs) {
              // 期限切れ → manual_review_required に降格
              tx.update(ref, {
                status: "manual_review_required",
                failedAt: isoToTimestamp(now),
              });
              return {
                reserved: false,
                reason: "lease_expired_promoted_to_manual_review",
              } satisfies ReservationOutcome;
            }
            return {
              reserved: false,
              reason: "currently_reserved_by_other_run",
            } satisfies ReservationOutcome;
          }
          default:
            // 未知 status は破損 → throw (silent 上書き禁止、rules/error-handling.md §2)
            throw new Error(
              `tryReserveCompletionNotification: unexpected existing status="${String(status)}" for ${tenantId}/${userId}`,
            );
        }
      }

      // 新規 reservation create
      const newRecord = {
        userId,
        status: "reserved" as CompletionNotificationStatus,
        runId,
        reservedAt: isoToTimestamp(now),
        leaseExpiresAt: isoToTimestamp(leaseExpiresAt),
        notifiedAt: null,
        messageId: null,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        progressSnapshot: {
          completedLessons: 0,
          totalLessons: 0,
          coursesCompleted: 0,
          coursesTotal: 0,
        },
        courseIdsSnapshot: [] as string[],
        publishedCourseCount: 0,
        recipientToHash: "",
        recipientCcHashes: [] as string[],
        pdfSizeBytes: null,
      };
      tx.set(ref, newRecord);
      return { reserved: true } satisfies ReservationOutcome;
    });
  }

  async markCompletionNotificationSent(input: MarkSentInput): Promise<void> {
    const ref = this.completionNotificationRef(input.tenantId, input.userId);
    // evaluator MEDIUM: lease 期限切れ後の降格 (reserved → manual_review_required) と
    // 遅延した markSent の race で manual_review_required → sent 上書きが起きうるため
    // read-then-write を runTransaction で保護する。
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) {
        throw new Error(
          `markCompletionNotificationSent: no reservation for ${input.tenantId}/${input.userId}`,
        );
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.status !== "reserved") {
        throw new Error(
          `markCompletionNotificationSent: status must be "reserved" but was "${String(data.status)}" for ${input.tenantId}/${input.userId}`,
        );
      }
      const updateData = {
        status: "sent" as CompletionNotificationStatus,
        messageId: input.messageId,
        notifiedAt: isoToTimestamp(input.notifiedAt),
        courseIdsSnapshot: input.courseIdsSnapshot,
        publishedCourseCount: input.courseIdsSnapshot.length,
        progressSnapshot: input.progressSnapshot,
        recipientToHash: input.recipientToHash,
        recipientCcHashes: input.recipientCcHashes,
        pdfSizeBytes: input.pdfSizeBytes,
      };
      tx.update(ref, sanitizeForUpdate(updateData));
    });
  }

  async markCompletionNotificationFailedPermanent(
    input: MarkFailedPermanentInput,
  ): Promise<void> {
    const ref = this.completionNotificationRef(input.tenantId, input.userId);
    // markSent と同様、lease 期限切れ降格との race を防ぐため runTransaction で保護
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) {
        throw new Error(
          `markCompletionNotificationFailedPermanent: no reservation for ${input.tenantId}/${input.userId}`,
        );
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.status !== "reserved") {
        throw new Error(
          `markCompletionNotificationFailedPermanent: status must be "reserved" but was "${String(data.status)}" for ${input.tenantId}/${input.userId}`,
        );
      }
      tx.update(
        ref,
        sanitizeForUpdate({
          status: "failed_permanent" as CompletionNotificationStatus,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          failedAt: isoToTimestamp(input.failedAt),
        }),
      );
    });
  }

  async getCompletionNotification(
    tenantId: string,
    userId: string,
  ): Promise<CompletionNotification | null> {
    const snap = (await this.completionNotificationRef(
      tenantId,
      userId,
    ).get()) as DocumentSnapshot;
    if (!snap.exists) return null;
    return toCompletionNotification(snap.data() ?? {});
  }

  // =====================================================================
  // Run lock
  // =====================================================================

  async acquireRunLock(input: AcquireRunLockInput): Promise<AcquireRunLockOutcome> {
    // 1. duplicate runId 検出 (uuid v4 衝突は天文学的だが防御として)
    const ref = this.runRef(input.runId);
    const existingSnap = (await ref.get()) as DocumentSnapshot;
    if (existingSnap.exists) {
      return { acquired: false, reason: "duplicate_run_id" };
    }

    // 2. 直近 lease 内に同 lane の running が居れば拒否
    //    spec §6.3 通り、query → set は best-effort (per-user reservation が真の安全装置)
    //
    //    実装メモ (code-review PLAUSIBLE 反映):
    //      理想は `where("status", "==", "running").where("leaseExpiresAt", ">", now).limit(1)`
    //      だが、これは composite index (Phase 7-B で追加予定) を要求する。本 PR では
    //      single-field where + アプリ側 lease 判定で fallback する。super_dispatch_runs は
    //      TTL 365 日 + status="running" は cron 1 起動で 1 件のみ create + completed/aborted/
    //      timeout 遷移で deselect されるため、長期残置 docs は数件レベル想定で線形 scan で
    //      問題ない。Phase 7-B で composite index 追加後に `.where(leaseExpiresAt > now).limit(1)`
    //      へ最適化する。
    //
    //    Phase 3 (ADR-039 D-1) 反映:
    //      lane は完全独立 → 同 lane の running のみが排他対象。別 lane (completion vs progress)
    //      の running は本 method の排他対象にしない (lane 並行起動を許可、各 lane 内の重複は
    //      `acquireLaneLock` 側で transactional に防ぐ)。既存 doc で `laneId` 欠落の場合は
    //      "completion" 扱い (interface コメント §AcquireRunLockInput 後方互換規約)。
    const nowMs = new Date(input.triggeredAt).getTime();
    const inputLaneId: DispatchLane = input.laneId ?? "completion";
    const runningSnap = await this.db
      .collection(COLL_RUNS)
      .where("status", "==", "running")
      .get();
    for (const doc of (runningSnap as { docs: DocumentSnapshot[] }).docs) {
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      const existingLaneId: DispatchLane =
        (data.laneId as DispatchLane | undefined) ?? "completion";
      if (existingLaneId !== inputLaneId) continue; // 別 lane は無関係
      const leaseIso = timestampToIso(data.leaseExpiresAt);
      const leaseMs = leaseIso ? new Date(leaseIso).getTime() : 0;
      if (leaseMs > nowMs) {
        return { acquired: false, reason: "another_run_active" };
      }
    }

    // 3. create
    // Phase 3 (ADR-039 D-1/D-2): laneId/occurrenceId は optional、undefined を doc に書かない
    // (sanitizeForUpdate ではないが手書きで対応、完了通知レーン後方互換)
    const newRun: Record<string, unknown> = {
      runId: input.runId,
      ...(input.laneId !== undefined && { laneId: input.laneId }),
      ...(input.occurrenceId !== undefined && { occurrenceId: input.occurrenceId }),
      triggeredAt: isoToTimestamp(input.triggeredAt),
      status: "running",
      leaseExpiresAt: isoToTimestamp(input.leaseExpiresAt),
      processedTenants: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      manualReviewRequired: 0,
      abortedReason: null,
      ttlExpireAt: isoToTimestamp(input.ttlExpireAt),
    };
    await ref.set(newRun);
    return {
      acquired: true,
      run: {
        runId: input.runId,
        ...(input.laneId !== undefined && { laneId: input.laneId }),
        ...(input.occurrenceId !== undefined && { occurrenceId: input.occurrenceId }),
        triggeredAt: input.triggeredAt,
        status: "running",
        leaseExpiresAt: input.leaseExpiresAt,
        processedTenants: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        manualReviewRequired: 0,
        abortedReason: null,
        ttlExpireAt: input.ttlExpireAt,
      },
    };
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
    const ref = this.runRef(input.runId);
    const snap = (await ref.get()) as DocumentSnapshot;
    if (!snap.exists) {
      throw new Error(`updateRunStatus: no run found for ${input.runId}`);
    }

    // abortedReason は aborted 遷移時のみ上書き、それ以外は明示クリア (rules/quality-gate 反映)
    const abortedReason =
      input.status === "aborted"
        ? input.abortedReason
        : input.abortedReason ?? null;

    const updateData: Record<string, unknown> = {
      status: input.status,
      processedTenants: input.processedTenants,
      sent: input.sent,
      skipped: input.skipped,
      failed: input.failed,
      manualReviewRequired: input.manualReviewRequired,
      abortedReason,
    };
    await ref.update(sanitizeForUpdate(updateData));
  }

  async getRun(runId: string): Promise<DispatchRun | null> {
    const snap = (await this.runRef(runId).get()) as DocumentSnapshot;
    if (!snap.exists) return null;
    return toDispatchRun(snap.data() ?? {});
  }

  async listRuns(): Promise<DispatchRun[]> {
    // 全件取得 (並び替え・paginate は route 層)。小規模 + TTL 365 日でデータ量限定的。
    const snap = (await this.db.collection(COLL_RUNS).get()) as {
      docs: DocumentSnapshot[];
    };
    return snap.docs.map((doc) => toDispatchRun(doc.data() ?? {}));
  }

  // =====================================================================
  // Audit log (best-effort)
  // =====================================================================

  async appendAuditLog(input: AppendAuditLogInput): Promise<void> {
    try {
      const data: Record<string, unknown> = {
        auditId: input.auditId,
        runId: input.runId,
        runStartedAt: isoToTimestamp(input.runStartedAt),
        eventType: input.eventType,
        tenantId: input.tenantId,
        userId: input.userId,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        durationMs: input.durationMs,
        createdAt: isoToTimestamp(input.createdAt),
        ttlExpireAt: isoToTimestamp(input.ttlExpireAt),
      };
      await this.auditLogRef(input.auditId).set(data);
    } catch (err) {
      // spec §6.1: 書き込み失敗は警告ログのみ、caller を block しない
      logger.warn("appendAuditLog: Firestore write failed (best-effort)", {
        errorType: "dispatch_audit_log_write_failed",
        auditId: input.auditId,
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async listAuditLogs(filter?: {
    runId?: string;
    eventType?: DispatchAuditLog["eventType"];
  }): Promise<DispatchAuditLog[]> {
    let query: FirebaseFirestore.Query = this.db.collection(COLL_AUDIT_LOGS);
    if (filter?.runId) {
      query = query.where("runId", "==", filter.runId);
    }
    if (filter?.eventType) {
      query = query.where("eventType", "==", filter.eventType);
    }
    const snap = (await query.get()) as { docs: DocumentSnapshot[] };
    return snap.docs.map((doc) => toAuditLog(doc.data() ?? {}));
  }

  // =====================================================================
  // Lane lock (Phase 3, ADR-039 D-4)
  // =====================================================================

  async acquireLaneLock(
    input: AcquireLaneLockInput,
  ): Promise<AcquireLaneLockOutcome> {
    const ref = this.laneLockRef(input.laneId);
    const nowMs = new Date(input.now).getTime();

    // read → lease 判定 → write を runTransaction で atomic に (Codex CRITICAL-3 中核)
    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (snap.exists) {
        const existing = toDispatchLaneLock(snap.data() ?? {});
        const leaseMs = new Date(existing.leaseExpiresAt).getTime();
        if (leaseMs > nowMs) {
          // lease 期限内: 他 run 保持中
          return {
            acquired: false as const,
            reason: "lane_lock_held_by_other_run" as const,
            currentLock: existing,
          };
        }
      }

      // 既存 lock なし or lease 切れ → 新規取得 (上書き update or 新規 set)
      const newLockData: Record<string, unknown> = {
        laneId: input.laneId,
        ownerRunId: input.ownerRunId,
        ...(input.occurrenceId !== undefined && {
          occurrenceId: input.occurrenceId,
        }),
        leaseExpiresAt: isoToTimestamp(input.leaseExpiresAt),
        acquiredAt: isoToTimestamp(input.now),
        updatedAt: isoToTimestamp(input.now),
      };
      tx.set(ref, newLockData);
      const lock: DispatchLaneLock = {
        laneId: input.laneId,
        ownerRunId: input.ownerRunId,
        ...(input.occurrenceId !== undefined && {
          occurrenceId: input.occurrenceId,
        }),
        leaseExpiresAt: input.leaseExpiresAt,
        acquiredAt: input.now,
        updatedAt: input.now,
      };
      return { acquired: true as const, lock };
    });
  }

  async completeLaneLock(input: CompleteLaneLockInput): Promise<void> {
    // ownerRunId 不一致なら no-op (Codex MEDIUM 反映)
    // read-then-delete を runTransaction で保護 (lease 切れ後の新 run による再取得を消さない)
    const ref = this.laneLockRef(input.laneId);
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) return;
      const existing = toDispatchLaneLock(snap.data() ?? {});
      if (existing.ownerRunId !== input.ownerRunId) return;
      tx.delete(ref);
    });
  }

  async abortLaneLock(input: AbortLaneLockInput): Promise<void> {
    // ownerRunId 不一致なら no-op (completeLaneLock と同じ契約)
    // abortedReason は本層では state に残さない (caller が audit に記録する想定)
    const ref = this.laneLockRef(input.laneId);
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) return;
      const existing = toDispatchLaneLock(snap.data() ?? {});
      if (existing.ownerRunId !== input.ownerRunId) return;
      tx.delete(ref);
    });
    void input.abortedReason;
  }

  // =====================================================================
  // Progress recipient state machine (Phase 3, ADR-039 D-3)
  // =====================================================================

  async tryClaimProgressRecipient(
    input: ClaimProgressRecipientInput,
  ): Promise<ProgressReportClaimOutcome> {
    const { tenantId, userId, occurrenceId, runId, now, leaseExpiresAt, ttlExpireAt } = input;
    const ref = this.progressRecipientRef(tenantId, occurrenceId, userId);
    const nowMs = new Date(now).getTime();

    return this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (snap.exists) {
        const data = (snap.data() ?? {}) as Record<string, unknown>;
        const status = data.status as ProgressReportRecipientStatus | undefined;
        switch (status) {
          case "sent":
            return {
              claimed: false,
              reason: "already_sent",
            } satisfies ProgressReportClaimOutcome;
          case "failed":
            return {
              claimed: false,
              reason: "already_failed",
            } satisfies ProgressReportClaimOutcome;
          case "manual_review_required":
            return {
              claimed: false,
              reason: "already_manual_review_required",
            } satisfies ProgressReportClaimOutcome;
          case "pending": {
            const leaseIso = timestampToIso(data.leaseExpiresAt);
            const leaseMs = leaseIso ? new Date(leaseIso).getTime() : 0;
            if (leaseMs <= nowMs) {
              // pending lease 切れ → manual_review_required に降格 (AC-PR-07)
              tx.update(ref, {
                status: "manual_review_required",
                promotedAt: isoToTimestamp(now),
              });
              return {
                claimed: false,
                reason: "pending_lease_expired_promoted_to_manual_review",
              } satisfies ProgressReportClaimOutcome;
            }
            return {
              claimed: false,
              reason: "currently_pending_by_other_worker",
            } satisfies ProgressReportClaimOutcome;
          }
          default:
            throw new Error(
              `tryClaimProgressRecipient: unexpected existing status="${String(status)}" for ${tenantId}/${occurrenceId}/${userId}`,
            );
        }
      }

      // 新規 claim: status=pending で create、ttlExpireAt は claim 時点で設定 (AC-PR-17)
      // PII hash (recipientToHash / recipientCcHashes) は markSent 時点で確定する設計
      const newRecord: Record<string, unknown> = {
        occurrenceId,
        runId,
        userId,
        status: "pending" as ProgressReportRecipientStatus,
        claimedAt: isoToTimestamp(now),
        leaseExpiresAt: isoToTimestamp(leaseExpiresAt),
        sentAt: null,
        messageId: null,
        pdfSizeBytes: null,
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        promotedAt: null,
        recipientToHash: "",
        recipientCcHashes: [] as string[],
        ttlExpireAt: isoToTimestamp(ttlExpireAt),
      };
      tx.set(ref, newRecord);
      return { claimed: true } satisfies ProgressReportClaimOutcome;
    });
  }

  async markProgressRecipientSent(
    input: MarkProgressRecipientSentInput,
  ): Promise<void> {
    const ref = this.progressRecipientRef(
      input.tenantId,
      input.occurrenceId,
      input.userId,
    );
    // 三者一致 precondition (Codex HIGH-2): status=pending + occurrenceId + runId 一致のみ更新
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) {
        throw new Error(
          `markProgressRecipientSent: no recipient for ${input.tenantId}/${input.occurrenceId}/${input.userId}`,
        );
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.status !== "pending") {
        throw new Error(
          `markProgressRecipientSent: status must be "pending" but was "${String(data.status)}" for ${input.tenantId}/${input.occurrenceId}/${input.userId}`,
        );
      }
      if (data.occurrenceId !== input.occurrenceId) {
        throw new Error(
          `markProgressRecipientSent: occurrenceId mismatch (expected="${String(data.occurrenceId)}", got="${input.occurrenceId}")`,
        );
      }
      if (data.runId !== input.runId) {
        throw new Error(
          `markProgressRecipientSent: runId mismatch (expected="${String(data.runId)}", got="${input.runId}")`,
        );
      }
      const updateData = {
        status: "sent" as ProgressReportRecipientStatus,
        sentAt: isoToTimestamp(input.sentAt),
        messageId: input.messageId,
        pdfSizeBytes: input.pdfSizeBytes,
        recipientToHash: input.recipientToHash,
        recipientCcHashes: input.recipientCcHashes,
      };
      tx.update(ref, sanitizeForUpdate(updateData));
    });
  }

  async markProgressRecipientFailed(
    input: MarkProgressRecipientFailedInput,
  ): Promise<void> {
    const ref = this.progressRecipientRef(
      input.tenantId,
      input.occurrenceId,
      input.userId,
    );
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) {
        throw new Error(
          `markProgressRecipientFailed: no recipient for ${input.tenantId}/${input.occurrenceId}/${input.userId}`,
        );
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.status !== "pending") {
        throw new Error(
          `markProgressRecipientFailed: status must be "pending" but was "${String(data.status)}" for ${input.tenantId}/${input.occurrenceId}/${input.userId}`,
        );
      }
      if (data.occurrenceId !== input.occurrenceId) {
        throw new Error(
          `markProgressRecipientFailed: occurrenceId mismatch (expected="${String(data.occurrenceId)}", got="${input.occurrenceId}")`,
        );
      }
      if (data.runId !== input.runId) {
        throw new Error(
          `markProgressRecipientFailed: runId mismatch (expected="${String(data.runId)}", got="${input.runId}")`,
        );
      }
      const updateData = {
        status: "failed" as ProgressReportRecipientStatus,
        failedAt: isoToTimestamp(input.failedAt),
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        recipientToHash: input.recipientToHash,
        recipientCcHashes: input.recipientCcHashes,
      };
      tx.update(ref, sanitizeForUpdate(updateData));
    });
  }

  async promotePendingToManualReview(
    input: PromotePendingToManualReviewInput,
  ): Promise<void> {
    const ref = this.progressRecipientRef(
      input.tenantId,
      input.occurrenceId,
      input.userId,
    );
    await this.db.runTransaction(async (tx: Transaction) => {
      const snap = (await tx.get(ref)) as DocumentSnapshot;
      if (!snap.exists) {
        throw new Error(
          `promotePendingToManualReview: no recipient for ${input.tenantId}/${input.occurrenceId}/${input.userId}`,
        );
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.status !== "pending") {
        throw new Error(
          `promotePendingToManualReview: status must be "pending" but was "${String(data.status)}" for ${input.tenantId}/${input.occurrenceId}/${input.userId}`,
        );
      }
      tx.update(ref, {
        status: "manual_review_required",
        promotedAt: isoToTimestamp(input.promotedAt),
      });
    });
  }

  async getProgressRecipient(
    input: GetProgressRecipientInput,
  ): Promise<ProgressReportRecipient | null> {
    const snap = (await this.progressRecipientRef(
      input.tenantId,
      input.occurrenceId,
      input.userId,
    ).get()) as DocumentSnapshot;
    if (!snap.exists) return null;
    return toProgressReportRecipient(snap.data() ?? {});
  }
}

// 型網羅性チェック (将来 status 追加時のコンパイルエラー検出)
const _statusCoverage: Record<CompletionNotificationStatus, true> = {
  reserved: true,
  sent: true,
  failed_permanent: true,
  manual_review_required: true,
};
void _statusCoverage;

// Phase 3 ADR-039 D-3: ProgressReportRecipientStatus の網羅性チェック
const _progressRecipientStatusCoverage: Record<ProgressReportRecipientStatus, true> = {
  pending: true,
  sent: true,
  failed: true,
  manual_review_required: true,
};
void _progressRecipientStatusCoverage;
