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
  DispatchLane,
  DispatchLaneLock,
  DispatchRun,
  DispatchRunStatus,
  DispatchSettings,
  ProgressReportClaimOutcome,
  ProgressReportRecipient,
  ProgressReportRecipientStatus,
  ReservationOutcome,
} from "@lms-279/shared-types";

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

/**
 * progress_report_sends の compound key 生成 (tenantId|occurrenceId|userId)。
 * Firestore impl の doc id (`${occurrenceId}__${userId}`) と異なり tenantId も含む
 * (InMemory では tenant subcollection に相当する分離が無いため key で表現)。
 */
type ProgressRecipientKey = string;
function pkey(tenantId: string, occurrenceId: string, userId: string): ProgressRecipientKey {
  return `${tenantId}${KEY_SEPARATOR}${occurrenceId}${KEY_SEPARATOR}${userId}`;
}

export class InMemoryDispatchStorage implements DispatchStorage {
  private notifications = new Map<NotificationKey, CompletionNotification>();
  private runs = new Map<string, DispatchRun>();
  private auditLogs: DispatchAuditLog[] = [];
  private settings: DispatchSettings | null = null;
  /** Phase 3 ADR-039 D-4: super_dispatch_lane_locks/{laneId} */
  private laneLocks = new Map<DispatchLane, DispatchLaneLock>();
  /** Phase 3 ADR-039 D-3: tenants/{tid}/progress_report_sends/{occurrenceId}__{userId} */
  private progressRecipients = new Map<ProgressRecipientKey, ProgressReportRecipient>();

  // テスト用クリアメソッド (production には呼ばない)
  __resetForTest(): void {
    this.notifications.clear();
    this.runs.clear();
    this.auditLogs = [];
    this.settings = null;
    this.laneLocks.clear();
    this.progressRecipients.clear();
  }

  /** テスト用 settings setter (Phase 5 で PUT API 経由のメソッドに置き換える) */
  __setSettingsForTest(settings: DispatchSettings | null): void {
    this.settings = settings;
  }

  // ===================================================================
  // Settings
  // ===================================================================

  async getDispatchSettings(): Promise<DispatchSettings | null> {
    return this.settings;
  }

  async updateDispatchSettings(
    input: UpdateDispatchSettingsInput,
  ): Promise<UpdateDispatchSettingsOutcome> {
    // doc 未作成時の現在 version は 0。read-modify-write は await を挟まず atomic。
    const currentVersion = this.settings?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      return {
        updated: false,
        reason: "version_conflict",
        current: this.settings,
      };
    }

    // patch semantics (ADR-039 HIGH-4): 既存 doc あり → undefined 既存値保持
    if (this.settings) {
      const next: DispatchSettings = {
        ...this.settings,
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
        version: currentVersion + 1,
      };
      this.settings = next;
      return { updated: true, settings: next };
    }

    // 初回 create: 必須 field 揃いを self-defense check (route 層で validate 済前提)
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
    const next: DispatchSettings = {
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
      version: currentVersion + 1,
    };
    this.settings = next;
    return { updated: true, settings: next };
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

    // 直近 lease 内に **同 lane の** running run が他にいれば拒否 (Phase 3 ADR-039 D-1 反映)。
    // 別 lane (completion vs progress) の running は無関係 (lane 並行起動を許可、
    // 各 lane 内の重複は `acquireLaneLock` 側で防ぐ)。
    // 既存 doc / input で laneId 欠落の場合は "completion" 扱い (後方互換規約)。
    const nowMs = Date.parse(input.triggeredAt);
    const inputLaneId: DispatchLane = input.laneId ?? "completion";
    for (const run of this.runs.values()) {
      if (run.status !== "running") continue;
      const existingLaneId: DispatchLane = run.laneId ?? "completion";
      if (existingLaneId !== inputLaneId) continue; // 別 lane は排他対象外
      if (Date.parse(run.leaseExpiresAt) > nowMs) {
        return { acquired: false, reason: "another_run_active" };
      }
    }

    const newRun: DispatchRun = {
      runId: input.runId,
      // Phase 3: optional field は明示的に指定された時のみ載せる (undefined を上書きしない)
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
      manualReviewRequired:
        input.manualReviewRequired ?? existing.manualReviewRequired,
      abortedReason,
    });
  }

  async getRun(runId: string): Promise<DispatchRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(): Promise<DispatchRun[]> {
    return Array.from(this.runs.values());
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

  // ===================================================================
  // Lane lock (Phase 3, ADR-039 D-4)
  // ===================================================================

  async acquireLaneLock(
    input: AcquireLaneLockInput,
  ): Promise<AcquireLaneLockOutcome> {
    // read-modify-write は await を挟まず atomic (Node.js single-threaded を活用)
    const existing = this.laneLocks.get(input.laneId);
    const nowMs = Date.parse(input.now);

    if (existing && Date.parse(existing.leaseExpiresAt) > nowMs) {
      // lease 期限内: 他 run 保持中
      return {
        acquired: false,
        reason: "lane_lock_held_by_other_run",
        currentLock: { ...existing },
      };
    }

    // 既存 lock なし or lease 切れ → 新規取得 (lease 切れの場合は上書き update)
    const newLock: DispatchLaneLock = {
      laneId: input.laneId,
      ownerRunId: input.ownerRunId,
      ...(input.occurrenceId !== undefined && {
        occurrenceId: input.occurrenceId,
      }),
      leaseExpiresAt: input.leaseExpiresAt,
      acquiredAt: input.now,
      updatedAt: input.now,
    };
    this.laneLocks.set(input.laneId, newLock);
    return { acquired: true, lock: { ...newLock } };
  }

  async completeLaneLock(input: CompleteLaneLockInput): Promise<void> {
    // ownerRunId 不一致なら no-op (古い run が新 lock を消さない、Codex MEDIUM 反映)
    const existing = this.laneLocks.get(input.laneId);
    if (!existing || existing.ownerRunId !== input.ownerRunId) {
      return;
    }
    this.laneLocks.delete(input.laneId);
  }

  async abortLaneLock(input: AbortLaneLockInput): Promise<void> {
    // ownerRunId 不一致なら no-op (completeLaneLock と同じ契約)
    const existing = this.laneLocks.get(input.laneId);
    if (!existing || existing.ownerRunId !== input.ownerRunId) {
      return;
    }
    this.laneLocks.delete(input.laneId);
    // abortedReason は本 InMemory impl では state に残さない (caller が audit に記録する想定)
    void input.abortedReason;
  }

  // ===================================================================
  // Progress recipient state machine (Phase 3, ADR-039 D-3)
  // ===================================================================

  async tryClaimProgressRecipient(
    input: ClaimProgressRecipientInput,
  ): Promise<ProgressReportClaimOutcome> {
    const { tenantId, userId, occurrenceId, runId, now, leaseExpiresAt, ttlExpireAt } = input;
    const key = pkey(tenantId, occurrenceId, userId);
    const existing = this.progressRecipients.get(key);

    // 既存 doc なし → 新規 create (await を挟まず atomic)
    if (!existing) {
      const claimed: ProgressReportRecipient = {
        occurrenceId,
        runId,
        userId,
        status: "pending",
        claimedAt: now,
        leaseExpiresAt,
        sentAt: null,
        messageId: null,
        pdfSizeBytes: null,
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        promotedAt: null,
        // PII hash は markSent 時点で確定する (完了通知レーンと同 pattern)
        recipientToHash: "",
        recipientCcHashes: [],
        ttlExpireAt,
      };
      this.progressRecipients.set(key, claimed);
      return { claimed: true };
    }

    // 既存 state による分岐
    switch (existing.status) {
      case "sent":
        return { claimed: false, reason: "already_sent" };
      case "failed":
        return { claimed: false, reason: "already_failed" };
      case "manual_review_required":
        return { claimed: false, reason: "already_manual_review_required" };
      case "pending": {
        const leaseExpired = Date.parse(existing.leaseExpiresAt) <= Date.parse(now);
        if (leaseExpired) {
          // pending lease 切れ → manual_review_required に降格 (AC-PR-07)
          this.progressRecipients.set(key, {
            ...existing,
            status: "manual_review_required",
            promotedAt: now,
          });
          return {
            claimed: false,
            reason: "pending_lease_expired_promoted_to_manual_review",
          };
        }
        return { claimed: false, reason: "currently_pending_by_other_worker" };
      }
      default: {
        // 型網羅性チェック (将来 status 追加時の早期検出)
        const _exhaustive: never = existing.status;
        throw new Error(
          `Unhandled progress recipient status: ${String(_exhaustive)}`,
        );
      }
    }
  }

  async markProgressRecipientSent(
    input: MarkProgressRecipientSentInput,
  ): Promise<void> {
    const key = pkey(input.tenantId, input.occurrenceId, input.userId);
    const existing = this.progressRecipients.get(key);
    if (!existing) {
      throw new Error(
        `markProgressRecipientSent: no recipient for ${key} (caller must claim first)`,
      );
    }
    // 三者一致 precondition (Codex HIGH-2): status=pending かつ occurrenceId/runId 一致
    if (existing.status !== "pending") {
      throw new Error(
        `markProgressRecipientSent: status must be "pending" but was "${existing.status}" for ${key}`,
      );
    }
    if (existing.occurrenceId !== input.occurrenceId) {
      throw new Error(
        `markProgressRecipientSent: occurrenceId mismatch (expected="${existing.occurrenceId}", got="${input.occurrenceId}") for ${key}`,
      );
    }
    if (existing.runId !== input.runId) {
      throw new Error(
        `markProgressRecipientSent: runId mismatch (expected="${existing.runId}", got="${input.runId}") for ${key}`,
      );
    }
    this.progressRecipients.set(key, {
      ...existing,
      status: "sent",
      sentAt: input.sentAt,
      messageId: input.messageId,
      pdfSizeBytes: input.pdfSizeBytes,
      recipientToHash: input.recipientToHash,
      recipientCcHashes: input.recipientCcHashes,
    });
  }

  async markProgressRecipientFailed(
    input: MarkProgressRecipientFailedInput,
  ): Promise<void> {
    const key = pkey(input.tenantId, input.occurrenceId, input.userId);
    const existing = this.progressRecipients.get(key);
    if (!existing) {
      throw new Error(
        `markProgressRecipientFailed: no recipient for ${key} (caller must claim first)`,
      );
    }
    // 三者一致 precondition (markProgressRecipientSent と同じ契約)
    if (existing.status !== "pending") {
      throw new Error(
        `markProgressRecipientFailed: status must be "pending" but was "${existing.status}" for ${key}`,
      );
    }
    if (existing.occurrenceId !== input.occurrenceId) {
      throw new Error(
        `markProgressRecipientFailed: occurrenceId mismatch (expected="${existing.occurrenceId}", got="${input.occurrenceId}") for ${key}`,
      );
    }
    if (existing.runId !== input.runId) {
      throw new Error(
        `markProgressRecipientFailed: runId mismatch (expected="${existing.runId}", got="${input.runId}") for ${key}`,
      );
    }
    this.progressRecipients.set(key, {
      ...existing,
      status: "failed",
      failedAt: input.failedAt,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      ...(input.recipientToHash !== undefined && {
        recipientToHash: input.recipientToHash,
      }),
      ...(input.recipientCcHashes !== undefined && {
        recipientCcHashes: input.recipientCcHashes,
      }),
    });
  }

  async promotePendingToManualReview(
    input: PromotePendingToManualReviewInput,
  ): Promise<void> {
    const key = pkey(input.tenantId, input.occurrenceId, input.userId);
    const existing = this.progressRecipients.get(key);
    if (!existing) {
      throw new Error(
        `promotePendingToManualReview: no recipient for ${key}`,
      );
    }
    if (existing.status !== "pending") {
      throw new Error(
        `promotePendingToManualReview: status must be "pending" but was "${existing.status}" for ${key}`,
      );
    }
    this.progressRecipients.set(key, {
      ...existing,
      status: "manual_review_required",
      promotedAt: input.promotedAt,
    });
  }

  async getProgressRecipient(
    input: GetProgressRecipientInput,
  ): Promise<ProgressReportRecipient | null> {
    const key = pkey(input.tenantId, input.occurrenceId, input.userId);
    return this.progressRecipients.get(key) ?? null;
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

// Phase 3 ADR-039 D-3: ProgressReportRecipientStatus の網羅性チェック
const _progressRecipientStatusCoverage: Record<ProgressReportRecipientStatus, true> = {
  pending: true,
  sent: true,
  failed: true,
  manual_review_required: true,
};
void _progressRecipientStatusCoverage;
