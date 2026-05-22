/**
 * DispatchStorage の InMemory 実装 (test / dev 用)。
 *
 * 設計仕様書 §4.1.3-4.1.5、ADR-028 「InMemoryDataSource 中心の統合テスト」に準拠。
 *
 * Phase 2 では本実装のみを用いて reservation / run-lock / audit の services を
 * Integration 検証する。Phase 4 で FirestoreDispatchStorage を追加し、
 * run-completion-notifications.ts は同 interface を介して両 backend で動作する。
 *
 * 並行制御:
 *   Node.js は single-threaded のため、await 境界以外では同期的に Map 操作が
 *   完結する。本実装は read-then-write の間に await を挟まないことで atomicity
 *   を担保する (Firestore runTransaction と同等のセマンティクスを単純な制御で実現)。
 */

import type {
  CompletionNotification,
  CompletionNotificationStatus,
  DispatchAuditLog,
  DispatchRun,
  DispatchRunStatus,
  ReservationOutcome,
} from "@lms-279/shared-types";

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

/**
 * completion_notifications の compound key 生成。
 *
 * separator に `|` (パイプ) を採用。Firestore doc ID 規約 / 一般的な tenant slug
 * (英数 + ハイフン) / userId (uuid 系) のいずれにも `|` は出現しないため、
 * `tenant-a/b` 形式 (evaluator narrative の collision 例) でも安全。
 */
type NotificationKey = string;
const KEY_SEPARATOR = "|";
function nkey(tenantId: string, userId: string): NotificationKey {
  return `${tenantId}${KEY_SEPARATOR}${userId}`;
}

export class InMemoryDispatchStorage implements DispatchStorage {
  private notifications = new Map<NotificationKey, CompletionNotification>();
  private runs = new Map<string, DispatchRun>();
  private auditLogs: DispatchAuditLog[] = [];

  // テスト用クリアメソッド (production には呼ばない)
  __resetForTest(): void {
    this.notifications.clear();
    this.runs.clear();
    this.auditLogs = [];
  }

  // ===================================================================
  // Reservation
  // ===================================================================

  async tryReserveCompletionNotification(
    input: ReserveCompletionNotificationInput,
  ): Promise<ReservationOutcome> {
    const { tenantId, userId, runId, now, leaseExpiresAt } = input;
    const key = nkey(tenantId, userId);
    const existing = this.notifications.get(key);

    // 状態判定 → 早期 return (await を挟まないため atomic)
    if (existing) {
      switch (existing.status) {
        case "sent":
          return { reserved: false, reason: "already_sent" };
        case "failed_permanent":
          return { reserved: false, reason: "failed_permanent" };
        case "manual_review_required":
          return { reserved: false, reason: "manual_review_required" };
        case "reserved": {
          // lease 期限判定
          const leaseExpired =
            Date.parse(existing.leaseExpiresAt) <= Date.parse(now);
          if (leaseExpired) {
            // manual_review_required に降格
            this.notifications.set(key, {
              ...existing,
              status: "manual_review_required",
              failedAt: now,
            });
            return {
              reserved: false,
              reason: "lease_expired_promoted_to_manual_review",
            };
          }
          return {
            reserved: false,
            reason: "currently_reserved_by_other_run",
          };
        }
        default: {
          // 想定外 status は型網羅性チェック (将来 status 追加時の早期検出)
          const _exhaustive: never = existing.status;
          throw new Error(`Unhandled reservation status: ${String(_exhaustive)}`);
        }
      }
    }

    // 新規予約 create
    const reserved: CompletionNotification = {
      userId,
      status: "reserved",
      runId,
      reservedAt: now,
      leaseExpiresAt,
      notifiedAt: null,
      messageId: null,
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      // snapshot は markSent 時にセット (Phase 4 caller 責務)、ここでは初期値
      progressSnapshot: {
        completedLessons: 0,
        totalLessons: 0,
        coursesCompleted: 0,
        coursesTotal: 0,
      },
      courseIdsSnapshot: [],
      publishedCourseCount: 0,
      recipientToHash: "",
      recipientCcHashes: [],
      pdfSizeBytes: null,
    };
    this.notifications.set(key, reserved);
    return { reserved: true };
  }

  async markCompletionNotificationSent(input: MarkSentInput): Promise<void> {
    const key = nkey(input.tenantId, input.userId);
    const existing = this.notifications.get(key);
    if (!existing) {
      throw new Error(
        `markCompletionNotificationSent: no reservation for ${key} (caller must reserve first)`,
      );
    }
    if (existing.status !== "reserved") {
      throw new Error(
        `markCompletionNotificationSent: status must be "reserved" but was "${existing.status}" for ${key}`,
      );
    }
    this.notifications.set(key, {
      ...existing,
      status: "sent",
      notifiedAt: input.notifiedAt,
      messageId: input.messageId,
      courseIdsSnapshot: input.courseIdsSnapshot,
      publishedCourseCount: input.courseIdsSnapshot.length,
      progressSnapshot: input.progressSnapshot,
      recipientToHash: input.recipientToHash,
      recipientCcHashes: input.recipientCcHashes,
      pdfSizeBytes: input.pdfSizeBytes,
    });
  }

  async markCompletionNotificationFailedPermanent(
    input: MarkFailedPermanentInput,
  ): Promise<void> {
    const key = nkey(input.tenantId, input.userId);
    const existing = this.notifications.get(key);
    if (!existing) {
      throw new Error(
        `markCompletionNotificationFailedPermanent: no reservation for ${key}`,
      );
    }
    if (existing.status !== "reserved") {
      throw new Error(
        `markCompletionNotificationFailedPermanent: status must be "reserved" but was "${existing.status}" for ${key}`,
      );
    }
    this.notifications.set(key, {
      ...existing,
      status: "failed_permanent",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      failedAt: input.failedAt,
    });
  }

  async getCompletionNotification(
    tenantId: string,
    userId: string,
  ): Promise<CompletionNotification | null> {
    return this.notifications.get(nkey(tenantId, userId)) ?? null;
  }

  // ===================================================================
  // Run lock
  // ===================================================================

  async acquireRunLock(
    input: AcquireRunLockInput,
  ): Promise<AcquireRunLockOutcome> {
    // duplicate runId は即時拒否 (uuid 衝突は天文学的だが防御として)
    if (this.runs.has(input.runId)) {
      return { acquired: false, reason: "duplicate_run_id" };
    }

    // 直近 lease 内に running run が他にいれば拒否
    const nowMs = Date.parse(input.triggeredAt);
    for (const run of this.runs.values()) {
      if (
        run.status === "running" &&
        Date.parse(run.leaseExpiresAt) > nowMs
      ) {
        return { acquired: false, reason: "another_run_active" };
      }
    }

    const newRun: DispatchRun = {
      runId: input.runId,
      triggeredAt: input.triggeredAt,
      status: "running",
      leaseExpiresAt: input.leaseExpiresAt,
      processedTenants: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      abortedReason: null,
      ttlExpireAt: input.ttlExpireAt,
    };
    this.runs.set(input.runId, newRun);
    return { acquired: true, run: newRun };
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
    const existing = this.runs.get(input.runId);
    if (!existing) {
      throw new Error(`updateRunStatus: no run found for ${input.runId}`);
    }
    // abortedReason: completed/timeout 遷移時は明示的に null クリアする。
    // aborted 遷移時は input.abortedReason で上書き (省略時のみ既存値保持)。
    // safe-refactor MEDIUM-3 反映。
    let abortedReason: string | null;
    if (input.status === "aborted") {
      abortedReason = input.abortedReason ?? existing.abortedReason;
    } else {
      // completed / timeout / running 等の非 aborted 遷移は abortedReason をクリア
      abortedReason = input.abortedReason ?? null;
    }
    this.runs.set(input.runId, {
      ...existing,
      status: input.status,
      processedTenants: input.processedTenants ?? existing.processedTenants,
      sent: input.sent ?? existing.sent,
      skipped: input.skipped ?? existing.skipped,
      failed: input.failed ?? existing.failed,
      abortedReason,
    });
  }

  async getRun(runId: string): Promise<DispatchRun | null> {
    return this.runs.get(runId) ?? null;
  }

  // ===================================================================
  // Audit log
  // ===================================================================

  async appendAuditLog(input: AppendAuditLogInput): Promise<void> {
    // best-effort: spec §6.1「書き込み失敗は警告ログのみ」のため try-catch
    try {
      this.auditLogs.push({
        auditId: input.auditId,
        runId: input.runId,
        runStartedAt: input.runStartedAt,
        eventType: input.eventType,
        tenantId: input.tenantId,
        userId: input.userId,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        durationMs: input.durationMs,
        createdAt: input.createdAt,
        ttlExpireAt: input.ttlExpireAt,
      });
    } catch {
      // InMemory では発生しないが、Firestore impl と同じ best-effort 契約を維持
    }
  }

  async listAuditLogs(filter?: {
    runId?: string;
    eventType?: DispatchAuditLog["eventType"];
  }): Promise<DispatchAuditLog[]> {
    return this.auditLogs.filter((log) => {
      if (filter?.runId && log.runId !== filter.runId) return false;
      if (filter?.eventType && log.eventType !== filter.eventType) return false;
      return true;
    });
  }
}

// 型網羅性チェック (CompletionNotificationStatus 追加時のコンパイルエラー検出)
const _statusCoverage: Record<CompletionNotificationStatus, true> = {
  reserved: true,
  sent: true,
  failed_permanent: true,
  manual_review_required: true,
};
void _statusCoverage;

const _runStatusCoverage: Record<DispatchRunStatus, true> = {
  running: true,
  completed: true,
  timeout: true,
  aborted: true,
};
void _runStatusCoverage;
