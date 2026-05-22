/**
 * DXcollege 自動完了通知システム DTO
 * 設計仕様書: docs/specs/2026-05-20-completion-notification-design.md
 *
 * 既存の手動 Gmail 下書き機能 (progress-pdf.ts、PR #434) と完全独立した別レーン。
 *
 * 関連 ADR: ADR-026 (DWD), ADR-029 (JST), ADR-034 (Phase 2 Gmail draft, PII hash)
 */

// ============================================================
// 配信設定 (super_dispatch_settings/global)
// ============================================================

export interface DispatchSettings {
  /** kill switch: false で次回 cron 起動時に即時停止 */
  enabled: boolean;
  /** 0-6 (日-土) の配信曜日。空配列なら常に skip */
  scheduleDaysOfWeek: number[];
  /** 0-23 の配信時刻 (JST、HH:00 単位) */
  scheduleHourJst: number;
  /** メール末尾の署名文字列 (例: "DXcollege運営スタッフ") */
  signatureName: string;
  /** 完了通知本文 (CRLF/カンマ/制御文字を含まない、上限 4000 文字) */
  completionMessageBody: string;
  /** 送信元 email (Cloud Run env DXCOLLEGE_SENDER_EMAIL から読み取り、編集不可) */
  senderEmail: string;
  /** 最終更新時刻 (ISO 8601) */
  updatedAt: string;
  /** 最終更新者の email (raw、監査責任明示のため hash 化しない) */
  updatedBy: string;
  /** 楽観的ロック用バージョン */
  version: number;
}

/** 設定取得レスポンス (senderEmail は env から読み取って併記、編集不可) */
export type GetDispatchSettingsResponse = DispatchSettings;

/**
 * 設定更新リクエスト (version 不一致で 409)。
 *
 * DispatchSettings から派生 (Pick) し、サーバー側で設定する senderEmail /
 * updatedAt / updatedBy は除外する。version は楽観的ロック用に含める。
 * DispatchSettings に新規 field を追加した際は、本 Pick にも追加するか
 * 自動的に PutRequest 対象外として扱うかを意識的に判断する。
 */
export type PutDispatchSettingsRequest = Pick<
  DispatchSettings,
  | "enabled"
  | "scheduleDaysOfWeek"
  | "scheduleHourJst"
  | "signatureName"
  | "completionMessageBody"
  | "version"
>;

export type DispatchSettingsErrorCode =
  | "invalid_schedule_days"
  | "invalid_schedule_hour"
  | "invalid_signature_name"
  | "invalid_completion_message_body"
  | "version_conflict"
  | "unauthorized"
  | "forbidden";

// ============================================================
// テナント別 CC 設定 (tenants/{tenantId} 拡張フィールド)
// ============================================================

export interface TenantNotificationCcConfig {
  /** 既存 tenants.ownerEmail (read-only、参考表示) */
  ownerEmail: string | null;
  /** 追加 CC email 配列 (上限 10 件、各 email は CRLF/カンマ/制御文字を含まない) */
  notificationCcEmails: string[];
  /** テナント単位の有効化フラグ、false で当テナントは配信対象外 */
  completionNotificationEnabled: boolean;
}

export type GetTenantNotificationCcResponse = TenantNotificationCcConfig;

export interface PutTenantNotificationCcRequest {
  notificationCcEmails: string[];
  completionNotificationEnabled: boolean;
}

export type TenantNotificationCcErrorCode =
  | "invalid_cc_emails"
  | "cc_emails_too_many"
  | "tenant_not_found"
  | "unauthorized"
  | "forbidden";

// notificationCcEmails 上限 / その他の制約値は DISPATCH_CONSTRAINTS に統一 (本ファイル末尾)

// ============================================================
// 完了通知 (tenants/{tenantId}/completion_notifications/{userId})
// ============================================================

/**
 * 完了通知の状態遷移 (設計仕様書 §4.2):
 * - reserved: pre-send transaction で確保、Gmail 送信中
 * - sent: Gmail 送信成功、終端 (idempotency キー)
 * - failed_permanent: 宛先固有の permanent 失敗、終端
 * - manual_review_required: lease 期限切れ、人手介入待ち、終端
 */
export type CompletionNotificationStatus =
  | "reserved"
  | "sent"
  | "failed_permanent"
  | "manual_review_required";

export interface CompletionNotificationProgressSnapshot {
  completedLessons: number;
  totalLessons: number;
  coursesCompleted: number;
  coursesTotal: number;
}

export interface CompletionNotification {
  userId: string;
  status: CompletionNotificationStatus;
  /** 予約した cron 実行 ID */
  runId: string;
  /** 予約時刻 (ISO 8601) */
  reservedAt: string;
  /** Lease 期限 (ISO 8601)。Date.now() > leaseExpiresAt で manual_review に降格 */
  leaseExpiresAt: string;
  /** 送信成功時刻 (status=sent のみ) */
  notifiedAt: string | null;
  /** Gmail API messageId (status=sent のみ) */
  messageId: string | null;
  /** sanitized error code (status=failed_permanent のみ) */
  errorCode: string | null;
  /** sanitized error message (status=failed_permanent のみ) */
  errorMessage: string | null;
  /** 失敗時刻 (status=failed_permanent のみ) */
  failedAt: string | null;
  /** 通知時点の進捗スナップショット */
  progressSnapshot: CompletionNotificationProgressSnapshot;
  /** 通知時点の published course ID 一覧 (案 C: 後からコース追加されても再送しない) */
  courseIdsSnapshot: string[];
  /** courseIdsSnapshot.length と同値、検索高速化用 */
  publishedCourseCount: number;
  /** sha256 ハッシュ (ADR-034 PII 最小化) */
  recipientToHash: string;
  /** sha256 配列 (CC) */
  recipientCcHashes: string[];
  pdfSizeBytes: number | null;
}

// ============================================================
// Run lock (super_dispatch_runs/{runId})
// ============================================================

export type DispatchRunStatus = "running" | "completed" | "timeout" | "aborted";

export interface DispatchRun {
  runId: string;
  /** cron 起動時刻 (ISO 8601) */
  triggeredAt: string;
  status: DispatchRunStatus;
  /** Lease 期限 (ISO 8601)。triggeredAt + 280 秒 (Cloud Run 300 秒に余裕) */
  leaseExpiresAt: string;
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  /**
   * manual_review_required に降格された user 数 (Phase 4 追加、evaluator 指摘反映)。
   * `manualReviewRequired` を `RunCompletionNotificationsResponse` と一致させ、
   * 管理画面で run 履歴を確認した際に件数追跡可能にする。
   */
  manualReviewRequired: number;
  /** abort 理由 (403 全体中断等、status=aborted のみ) */
  abortedReason: string | null;
  /** TTL 期限 (ISO 8601)、triggeredAt + 365 days */
  ttlExpireAt: string;
}

// ============================================================
// 内部 API レスポンス (Cloud Scheduler → Cloud Run)
// ============================================================

export interface RunCompletionNotificationsResponse {
  runId: string;
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  manualReviewRequired: number;
}

// ============================================================
// Audit log (super_dispatch_audit_logs)
// ============================================================

export type DispatchAuditEventType =
  | "run_started"
  | "run_completed"
  | "run_aborted"
  | "user_reserved"
  | "user_notified"
  | "user_skipped"
  | "user_failed_transient"
  | "user_failed_permanent"
  | "manual_review_required"
  | "settings_updated"
  | "test_send"
  | "dry_run"
  | "orphan_send";

export interface DispatchAuditLog {
  auditId: string;
  runId: string;
  runStartedAt: string;
  eventType: DispatchAuditEventType;
  tenantId: string | null;
  userId: string | null;
  errorCode: string | null;
  /** sanitizeErrorForAudit() 済み (PII 除去後) */
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  /** TTL 期限 (Firestore TTL Policy で 1 年自動削除) */
  ttlExpireAt: string;
}

export interface GetAuditLogsQuery {
  tenantId?: string;
  userId?: string;
  eventType?: DispatchAuditEventType;
  /** ISO 8601 */
  from?: string;
  /** ISO 8601 */
  to?: string;
  /** ページサイズ、default 50、max 200 */
  limit?: number;
  /** ページネーション用 */
  cursor?: string;
}

export interface GetAuditLogsResponse {
  logs: DispatchAuditLog[];
  nextCursor: string | null;
}

// ============================================================
// Dry-run
// ============================================================

export interface DryRunTarget {
  tenantId: string;
  userId: string;
  /** 受講者 email (UI 表示用、PII 含むためログには出さない) */
  userEmail: string;
  userName: string;
  progressSnapshot: CompletionNotificationProgressSnapshot;
}

export interface DryRunResponse {
  /** 次回 cron で送信される対象一覧 (Gmail 送信も Reservation も実行されない) */
  wouldNotify: DryRunTarget[];
  /** 評価時刻 (ISO 8601) */
  evaluatedAt: string;
}

// ============================================================
// Test-send (固定ダミーデータ + 添付なし、スーパー管理者自身宛)
// ============================================================

export interface TestSendResponse {
  /** Gmail API messageId */
  messageId: string;
  /** 送信先 (スーパー管理者自身の email) */
  sentTo: string;
  sentAt: string;
}

export type TestSendErrorCode =
  | "rate_limit_exceeded"
  | "gmail_api_error"
  | "gmail_api_transient"
  | "dwd_token_failed"
  | "unauthorized"
  | "forbidden";

// test-send 1 日あたりレート制限は DISPATCH_CONSTRAINTS.TEST_SEND_DAILY_LIMIT を参照

// ============================================================
// Reservation transaction の結果 (内部 service 用)
// ============================================================

export type ReservationOutcome =
  | { reserved: true }
  | {
      reserved: false;
      reason:
        | "already_sent"
        | "failed_permanent"
        | "manual_review_required"
        | "currently_reserved_by_other_run"
        | "lease_expired_promoted_to_manual_review";
    };

// ============================================================
// Gmail 403 reason 分類 (内部 service 用)
// ============================================================

export type Gmail403Classification = "scope_revoked" | "user_permanent";

// ============================================================
// 制約値 (export して FE/BE で共有)
// ============================================================

export const DISPATCH_CONSTRAINTS = {
  /** notificationCcEmails 上限 */
  NOTIFICATION_CC_EMAILS_MAX: 10,
  /** signatureName 文字数上限 */
  SIGNATURE_NAME_MAX_LENGTH: 100,
  /** completionMessageBody 文字数上限 */
  COMPLETION_MESSAGE_BODY_MAX_LENGTH: 4000,
  /** test-send 1 日あたり上限 */
  TEST_SEND_DAILY_LIMIT: 50,
  /** Reservation lease 期限 (ミリ秒) */
  RESERVATION_LEASE_MS: 10 * 60 * 1000,
  /** Dispatch run lease 期限 (ミリ秒、Cloud Run 300 秒に余裕) */
  DISPATCH_RUN_LEASE_MS: 280 * 1000,
  /** Audit logs TTL (日) */
  AUDIT_LOGS_TTL_DAYS: 365,
  /** sanitized error message 上限 */
  SANITIZED_ERROR_MESSAGE_MAX_LENGTH: 1024,
} as const;
