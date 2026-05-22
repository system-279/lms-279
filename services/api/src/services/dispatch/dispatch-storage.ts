/**
 * DXcollege 自動完了通知システムの Firestore I/O 抽象 layer。
 *
 * 設計仕様書 §4.1.3-4.1.5、§6.2-6.3、FR-7 改訂 / FR-11 / FR-12 / NFR-3 改訂 に対応。
 *
 * 目的:
 *   - reservation.ts / run-lock.ts / dispatch-audit.ts の 3 services を
 *     storage 実装非依存 (InMemory / Firestore どちらでも動く) にする
 *   - ADR-028 「InMemoryDataSource 中心の統合テスト」に準拠した unit/integration test
 *   - Phase 2 では InMemoryDispatchStorage のみ実装、Firestore 実装は Phase 4 で
 *     接続 (run-completion-notifications.ts と同時)
 *
 * 設計原則:
 *   - reservation / run-lock は **transactional atomicity** を保証する
 *     (Firestore: runTransaction、InMemory: process 内排他制御)
 *   - audit log は best-effort (write 失敗で caller の処理を block しない)
 *
 * 関連 ADR: ADR-028 (テスト戦略), ADR-029 (JST), ADR-034 (PII 最小化)
 */

import type {
  CompletionNotification,
  CompletionNotificationStatus,
  DispatchAuditLog,
  DispatchRun,
  DispatchRunStatus,
  ReservationOutcome,
} from "@lms-279/shared-types";

// ============================================================
// Reservation (tenants/{tenantId}/completion_notifications/{userId})
// ============================================================

/**
 * Reservation 試行入力。
 *
 * lease 期間 (ms) は呼び出し側で算出して渡す
 * (`DISPATCH_CONSTRAINTS.RESERVATION_LEASE_MS` = 10 分が既定)。
 */
export interface ReserveCompletionNotificationInput {
  tenantId: string;
  userId: string;
  runId: string;
  /** 現在時刻 (ISO 8601、テスト時固定可) */
  now: string;
  /** lease 有効期限 (now + RESERVATION_LEASE_MS、ISO 8601) */
  leaseExpiresAt: string;
}

/**
 * 送信成功時の completion_notifications 更新入力。
 * Reservation で create したレコードに sent state field を追加更新する。
 */
export interface MarkSentInput {
  tenantId: string;
  userId: string;
  /** Gmail API messageId */
  messageId: string;
  /** 送信成功時刻 (ISO 8601) */
  notifiedAt: string;
  /** 通知時点 published course ID 一覧 (案 C、FR-12) */
  courseIdsSnapshot: string[];
  /** 通知時点進捗スナップショット */
  progressSnapshot: CompletionNotification["progressSnapshot"];
  /** 受講者 email の sha256 (ADR-034、PII 最小化) */
  recipientToHash: string;
  /** CC email 配列の sha256 (順序保持) */
  recipientCcHashes: string[];
  /** PDF 添付サイズ (添付なしなら null) */
  pdfSizeBytes: number | null;
}

/**
 * Permanent 失敗時の completion_notifications 更新入力。
 * caller は errorMessage を `sanitizeErrorForAudit()` で sanitize 済を渡す。
 */
export interface MarkFailedPermanentInput {
  tenantId: string;
  userId: string;
  /** 失敗時刻 (ISO 8601) */
  failedAt: string;
  /** sanitized error code (caller 責務、PII 含まない) */
  errorCode: string;
  /** sanitized error message (caller 責務、PII 含まない) */
  errorMessage: string;
}

// ============================================================
// Run lock (super_dispatch_runs/{runId})
// ============================================================

export interface AcquireRunLockInput {
  /** uuid v4 (caller 生成、競合検出に使う) */
  runId: string;
  /** cron 起動時刻 (ISO 8601) */
  triggeredAt: string;
  /** lease 有効期限 (triggeredAt + DISPATCH_RUN_LEASE_MS、ISO 8601) */
  leaseExpiresAt: string;
  /** TTL 自動削除期限 (triggeredAt + AUDIT_LOGS_TTL_DAYS、ISO 8601) */
  ttlExpireAt: string;
}

export type AcquireRunLockOutcome =
  | { acquired: true; run: DispatchRun }
  | {
      acquired: false;
      reason:
        | "another_run_active"
        | "duplicate_run_id";
    };

export interface UpdateRunStatusInput {
  runId: string;
  status: DispatchRunStatus;
  /** completed/aborted/timeout 時のメトリクス (積算結果) */
  processedTenants?: number;
  sent?: number;
  skipped?: number;
  failed?: number;
  /** aborted 時の理由 (sanitized) */
  abortedReason?: string;
}

// ============================================================
// Audit log (super_dispatch_audit_logs/{auditId})
// ============================================================

export interface AppendAuditLogInput {
  /** uuid v4 (caller 生成、重複検出/idempotency 不要) */
  auditId: string;
  /** 紐付く run の ID */
  runId: string;
  /** run 開始時刻 (ISO 8601、フィルタ用) */
  runStartedAt: string;
  eventType: DispatchAuditLog["eventType"];
  tenantId: string | null;
  userId: string | null;
  /** sanitized (PII 含まない) */
  errorCode: string | null;
  /** sanitized (PII 含まない、caller が sanitizeErrorForAudit 済を渡す) */
  errorMessage: string | null;
  /** 処理経過時間 (null 可) */
  durationMs: number | null;
  /** 書き込み時刻 (ISO 8601) */
  createdAt: string;
  /** TTL 自動削除期限 (ISO 8601、createdAt + AUDIT_LOGS_TTL_DAYS) */
  ttlExpireAt: string;
}

// ============================================================
// DispatchStorage interface
// ============================================================

export interface DispatchStorage {
  // ----- Reservation -----
  /**
   * Pre-send reservation を transactional に取得する。
   *
   * 設計仕様書 §6.2 (Reservation 方式)、AC-10/11/12、FR-7 改訂、NFR-3 改訂 対応。
   *
   * 戻り値:
   *   - `reserved: true`: 新規 create 成功または lease 期限切れ降格後の再 create
   *   - `reserved: false` + reason: 既存 state により skip
   *     - "already_sent": status=sent
   *     - "failed_permanent": status=failed_permanent
   *     - "manual_review_required": status=manual_review_required
   *     - "currently_reserved_by_other_run": status=reserved & lease 期限内
   *     - "lease_expired_promoted_to_manual_review": status=reserved & lease 期限切れ
   *       → manual_review_required に降格し、本 run は skip
   */
  tryReserveCompletionNotification(
    input: ReserveCompletionNotificationInput,
  ): Promise<ReservationOutcome>;

  /** 送信成功時の status=sent 遷移 + sent fields 更新 (FR-12 含む snapshot 保存) */
  markCompletionNotificationSent(input: MarkSentInput): Promise<void>;

  /** Permanent 失敗時の status=failed_permanent 遷移 + error fields 更新 */
  markCompletionNotificationFailedPermanent(
    input: MarkFailedPermanentInput,
  ): Promise<void>;

  /**
   * 完了通知レコードの取得 (主にテスト/audit/dry-run 用)。
   * 通常の業務ロジックでは reserve → mark sent/failed のフローで使うため、本メソッド
   * は副作用なしの read-only 用途のみに使う。
   */
  getCompletionNotification(
    tenantId: string,
    userId: string,
  ): Promise<CompletionNotification | null>;

  // ----- Run lock -----
  /**
   * Run lock を transactional に取得する。
   *
   * 設計仕様書 §6.3、FR-11、AC-16 対応。
   * 直近 lease 期限内に他の running run があれば取得拒否
   * (Cloud Scheduler 重複起動対策)。
   */
  acquireRunLock(input: AcquireRunLockInput): Promise<AcquireRunLockOutcome>;

  /** Run status 遷移 (completed / timeout / aborted) + メトリクス積算更新 */
  updateRunStatus(input: UpdateRunStatusInput): Promise<void>;

  /** Run 取得 (主にテスト/audit 用) */
  getRun(runId: string): Promise<DispatchRun | null>;

  // ----- Audit log -----
  /**
   * Audit log 追記。設計仕様書 §6.1「super_dispatch_audit_logs 書き込み失敗は
   * 警告ログのみ、レスポンスをブロックしない」原則に従い、実装側で best-effort
   * (例外を throw しない) を保証する。caller は本メソッドを await しても安全。
   *
   * NFR-11 (PII sanitize): caller は errorMessage を sanitizeErrorForAudit 済の
   * 値で渡す前提。storage 側で再 sanitize はしない (二重 redaction のリスク回避)。
   */
  appendAuditLog(input: AppendAuditLogInput): Promise<void>;

  /** Audit log 全件取得 (主にテスト用、本番 API は別 query で paginate) */
  listAuditLogs(filter?: {
    runId?: string;
    eventType?: DispatchAuditLog["eventType"];
  }): Promise<DispatchAuditLog[]>;
}

// ============================================================
// 内部 helper: status 表現の型 narrowing
// ============================================================

/**
 * 既存 reservation を skip 対象として扱うべき status 一覧 (lease 評価前)。
 * reservation.ts / DispatchStorage 実装で共通参照する。
 */
export const TERMINAL_RESERVATION_STATUSES: ReadonlySet<CompletionNotificationStatus> =
  new Set(["sent", "failed_permanent", "manual_review_required"]);
