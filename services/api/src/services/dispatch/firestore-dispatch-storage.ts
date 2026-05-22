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
  type DispatchRun,
  type DispatchRunStatus,
  type DispatchSettings,
  type ReservationOutcome,
} from "@lms-279/shared-types";

import { logger } from "../../utils/logger.js";

import type {
  AcquireRunLockInput,
  AcquireRunLockOutcome,
  AppendAuditLogInput,
  DispatchStorage,
  MarkFailedPermanentInput,
  MarkSentInput,
  ReserveCompletionNotificationInput,
  UpdateRunStatusInput,
} from "./dispatch-storage.js";

// ============================================================
// Firestore collection paths
// ============================================================

const COLL_SETTINGS = "super_dispatch_settings";
const DOC_SETTINGS_GLOBAL = "global";
const COLL_RUNS = "super_dispatch_runs";
const COLL_AUDIT_LOGS = "super_dispatch_audit_logs";

function completionNotificationsCollection(tenantId: string): string {
  return `tenants/${tenantId}/completion_notifications`;
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
    updatedAt: requireIso(data.updatedAt, "updatedAt"),
    updatedBy: data.updatedBy as string,
    version: data.version as number,
  };
}

function toDispatchRun(data: Record<string, unknown>): DispatchRun {
  return {
    runId: data.runId as string,
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

  // =====================================================================
  // Settings
  // =====================================================================

  async getDispatchSettings(): Promise<DispatchSettings | null> {
    const snap = (await this.settingsRef().get()) as DocumentSnapshot;
    if (!snap.exists) return null;
    return toDispatchSettings(snap.data() ?? {});
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

    // 2. 直近 lease 内に他の running が居れば拒否
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
    const nowMs = new Date(input.triggeredAt).getTime();
    const runningSnap = await this.db
      .collection(COLL_RUNS)
      .where("status", "==", "running")
      .get();
    for (const doc of (runningSnap as { docs: DocumentSnapshot[] }).docs) {
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      const leaseIso = timestampToIso(data.leaseExpiresAt);
      const leaseMs = leaseIso ? new Date(leaseIso).getTime() : 0;
      if (leaseMs > nowMs) {
        return { acquired: false, reason: "another_run_active" };
      }
    }

    // 3. create
    const newRun: Record<string, unknown> = {
      runId: input.runId,
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
}

// 型網羅性チェック (将来 status 追加時のコンパイルエラー検出)
const _statusCoverage: Record<CompletionNotificationStatus, true> = {
  reserved: true,
  sent: true,
  failed_permanent: true,
  manual_review_required: true,
};
void _statusCoverage;
