/**
 * DXcollege 自動完了通知システム DTO + Phase 3 進捗レポート定期自動配信 DTO
 *
 * 設計仕様書:
 *  - docs/specs/2026-05-20-completion-notification-design.md (完了通知)
 *  - docs/specs/2026-06-01-progress-report-dispatch-design.md (Phase 3 進捗レポート)
 *
 * 既存の手動 Gmail 下書き機能 (progress-pdf.ts、PR #434) と完全独立した別レーン。
 *
 * 関連 ADR:
 *  - ADR-026 (DWD), ADR-029 (JST), ADR-034 (Phase 2 Gmail draft, PII hash)
 *  - ADR-037 (sender impersonation SendAs)
 *  - ADR-039 (Phase 3 進捗レポート定期自動配信、レーン分離・冪等設計・テナント opt-out 分離)
 */

// ============================================================
// 配信レーン識別子 (ADR-039 D-1 / D-4)
// ============================================================

/**
 * 配信レーンの識別子。両レーンは別 endpoint + 別 Cloud Scheduler job + 別 lane lock。
 *  - completion: 既存の完了通知レーン (run-completion-notifications.ts、1 人 1 回 reservation、100% 完了者のみ)
 *  - progress: Phase 3 で追加した進捗レポート定期自動配信レーン (run-progress-reports.ts、1 run 1 回、active 受講者)
 *
 * 既存 DispatchRun doc は laneId 欠落時 "completion" 扱い (後方互換)。
 */
export type DispatchLane = "completion" | "progress";

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
  /**
   * Phase 3 進捗レポート定期自動配信の設定 (ADR-039 D-1)。
   * undefined または enabled=false で当レーン無効。完了通知レーンへの影響なし。
   * 既存テナントは undefined のまま動く (マイグレーション不要、ADR-039 D-6)。
   */
  progressReport?: ProgressReportSettings;
  /** 最終更新時刻 (ISO 8601) */
  updatedAt: string;
  /** 最終更新者の email (raw、監査責任明示のため hash 化しない) */
  updatedBy: string;
  /** 楽観的ロック用バージョン */
  version: number;
}

/**
 * 進捗レポート定期自動配信の設定 (DispatchSettings.progressReport)。
 * 完了通知と独立したスケジュール (曜日・時刻)。
 *
 * 設定 UI で切替不可な固定挙動 (ADR-039 OQ #2 / #4):
 *  - skipCompletedUsers=true (100% 完了者は除外、完了通知レーンが既にカバー)
 *  - includeAttachment=true (PDF 添付あり、手動レーン ADR-034 と同等)
 *  - 受講中フィルタ厳密 (active + enrollment + 不退会 + 期限内 + 1% 以上、ADR-039 D-5)
 */
export interface ProgressReportSettings {
  /** kill switch: false で次回 cron 起動時に即時停止 (完了通知への影響なし) */
  enabled: boolean;
  /** 0-6 (日-土) の配信曜日。完了通知の scheduleDaysOfWeek と独立 */
  scheduleDaysOfWeek: number[];
  /** 0-23 の配信時刻 (JST、HH:00 単位)。完了通知の scheduleHourJst と独立 */
  scheduleHourJst: number;
}

/** 設定取得レスポンス (senderEmail は env から読み取って併記、編集不可) */
export type GetDispatchSettingsResponse = DispatchSettings;

/**
 * 設定更新リクエスト (PUT は patch semantics、ADR-039 HIGH-4 反映)。
 *
 * 全 settings field は optional (undefined で既存値保持、storage 層で merge)。
 * version のみ必須 (楽観的ロック、doc 未作成時は 0)。
 *
 * - FE は always-send-all 戦略で完了通知関連 field を毎回送信し、旧 UI 経由での
 *   意図しないフィールド消失を防ぐ
 * - progressReport は新規追加 field のため、旧 UI 由来の PUT (progressReport 欠落)
 *   でも既存値が消えない (HIGH-4 の本質)
 * - 初回 create 時は route 層で「completion 関連 5 field と senderEmail が揃っているか」
 *   をバリデーション (storage 層では未指定 field をそのまま undefined として merge)
 *
 * Codex review (Plan stage thread 019e8a8d) MEDIUM-M3 反映:
 *   patch semantics と言いつつ Pick のままだと型上 completion fields が必須となり
 *   T5 (UpdateDispatchSettingsInput を optional 化) と型矛盾する。`Partial<Pick<...>>`
 *   で全 field optional 化 + version のみ必須に修正。
 */
export type PutDispatchSettingsRequest = Partial<
  Pick<
    DispatchSettings,
    | "enabled"
    | "scheduleDaysOfWeek"
    | "scheduleHourJst"
    | "signatureName"
    | "completionMessageBody"
    | "progressReport"
  >
> & {
  /** 楽観的ロック (必須): doc 未作成時は 0 を期待値とする */
  version: number;
};

export type DispatchSettingsErrorCode =
  | "invalid_schedule_days"
  | "invalid_schedule_hour"
  | "invalid_signature_name"
  | "invalid_completion_message_body"
  | "invalid_progress_report_schedule_days"
  | "invalid_progress_report_schedule_hour"
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
  /** テナント単位の完了通知レーン有効化フラグ、false で当テナントは完了通知対象外 */
  completionNotificationEnabled: boolean;
  /**
   * テナント単位の進捗レポート定期自動配信レーン有効化フラグ (Phase 3、ADR-039 D-6)。
   * default false (opt-in)。完了通知レーンとは独立。
   * undefined で false と同等 (マイグレーション不要、後方互換)。
   */
  progressReportEnabled?: boolean;
}

export type GetTenantNotificationCcResponse = TenantNotificationCcConfig;

export interface PutTenantNotificationCcRequest {
  notificationCcEmails: string[];
  completionNotificationEnabled: boolean;
  /** Phase 3 (ADR-039 D-6)、undefined で既存値保持 (patch semantics) */
  progressReportEnabled?: boolean;
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
  /**
   * 配信レーン識別子 (Phase 3、ADR-039 D-1)。
   * 既存 doc で欠落時は "completion" 扱い (後方互換)。
   */
  laneId?: DispatchLane;
  /**
   * Phase 3 進捗レポートレーンのみ設定される (ADR-039 D-2)。
   * sha256(laneId + X-CloudScheduler-ScheduleTime) で算出され、Cloud Scheduler の
   * at-least-once delivery における同 scheduled execution の retry を冪等化する。
   * 完了通知レーンでは undefined。
   */
  occurrenceId?: string;
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
// Lane lock (super_dispatch_lane_locks/{laneId}) — Phase 3 ADR-039 D-4
// ============================================================

/**
 * 配信レーン別の排他 lock (ADR-039 D-4)。
 * 既存 `run-lock.ts` の query→set best-effort では同 lane 並行 request の race を
 * 解消できないため、`super_dispatch_lane_locks/{laneId}` 別 doc で
 * `tx.get → lease 判定 → tx.set` を Firestore transaction として実行する。
 *
 * 完了通知レーンの既存 run-lock は Phase 3 で破壊せず、Phase 4 で lane-lock 統合検討。
 */
export interface DispatchLaneLock {
  laneId: DispatchLane;
  /** 現在 lock を保持している runId */
  ownerRunId: string;
  /** 進捗レポートレーンのみ設定 (完了通知では undefined) */
  occurrenceId?: string;
  /** Lease 期限 (ISO 8601)。Date.now() > leaseExpiresAt で他 runner が再取得可能 */
  leaseExpiresAt: string;
  /** 取得時刻 (ISO 8601) */
  acquiredAt: string;
  /** 最終更新時刻 (ISO 8601) */
  updatedAt: string;
}

/** run 履歴取得クエリ (Phase 5 super-admin runs API) */
export interface GetRunsQuery {
  /** ページサイズ、default 50、max 200 */
  limit?: number;
  /** ページネーション用 cursor (前ページ末尾 run の triggeredAt) */
  cursor?: string;
}

export interface GetRunsResponse {
  /** triggeredAt 降順 (新しい run が先頭) */
  runs: DispatchRun[];
  nextCursor: string | null;
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

/**
 * 進捗レポート定期自動配信レーン (Phase 3) 実行レスポンス (ADR-039 D-1)。
 * `RunCompletionNotificationsResponse` と異なり `occurrenceId` を含む (冪等性キー)。
 *
 * - pendingPromotedToManualReview: pending lease 切れで降格された user 数
 * - laneLockContention: lane lock 取得失敗で no-op 終了したか
 */
export interface RunProgressReportsResponse {
  runId: string;
  /** Cloud Scheduler at-least-once delivery 対応の冪等性キー (ADR-039 D-2) */
  occurrenceId: string;
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  pendingPromotedToManualReview: number;
  laneLockContention: boolean;
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
  | "orphan_send"
  // ↓ Phase 3 進捗レポート定期自動配信 (ADR-039)
  | "progress_report_run_started"
  | "progress_report_run_completed"
  | "progress_report_run_aborted"
  | "progress_report_sent"
  | "progress_report_failed"
  | "user_skipped_completed"
  | "pdf_too_large"
  | "pending_promoted_to_manual_review"
  | "lane_lock_contention";

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
// Dry-run / Test-send は 2026-05-24 PR-B で UI 撤廃に伴い削除済み
//   - dry-run の代替: scripts/dispatch-dry-run-cli.ts + .github/workflows/dispatch-dry-run.yml
//   - test-send の代替: scripts/smoke-dwd-gmail-send.ts + .github/workflows/smoke-dwd-gmail-send.yml
//     (SendAs send smoke、固定 dummy + 開発者宛)
// 関連: 設計仕様書 FR-8 / AC-8 / AC-9 (UI 撤廃に伴い改訂)
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
// 進捗レポート定期自動配信 recipient (Phase 3、ADR-039 D-3)
// tenants/{tenantId}/progress_report_sends/{occurrenceId}__{userId}
// ============================================================

/**
 * 進捗レポート recipient の状態遷移 (ADR-039 D-3、Codex CRITICAL-2 反映)。
 * 完了通知の `CompletionNotificationStatus` (userId 単位・永続) とは別目的で、
 * occurrence 単位の at-most-once attempt 保証 + crash 後 orphan 防御を担う。
 *
 *  - pending: claim 直後の状態 (lease 10 min + ttlExpireAt 同時設定)
 *  - sent: Gmail 受理 + markSent 完了、終端
 *  - failed: permanent error、終端
 *  - manual_review_required: pending lease 切れの降格状態、自動再送せず手動確認
 */
export type ProgressReportRecipientStatus =
  | "pending"
  | "sent"
  | "failed"
  | "manual_review_required";

export interface ProgressReportRecipient {
  /** Cloud Scheduler at-least-once 冪等性キー (ADR-039 D-2) */
  occurrenceId: string;
  /** HTTP attempt 単位の監査用 UUID */
  runId: string;
  userId: string;
  status: ProgressReportRecipientStatus;
  /** claim 時刻 (ISO 8601) */
  claimedAt: string;
  /** Lease 期限 (ISO 8601)。pending 時のみ意味を持つ */
  leaseExpiresAt: string;
  /** 送信成功時刻 (status=sent のみ) */
  sentAt: string | null;
  /** Gmail API messageId (status=sent のみ) */
  messageId: string | null;
  /** 送信した PDF サイズ (status=sent のみ) */
  pdfSizeBytes: number | null;
  /** 失敗時刻 (status=failed のみ) */
  failedAt: string | null;
  /** sanitized error code (status=failed のみ) */
  errorCode: string | null;
  /** sanitized error message (status=failed のみ) */
  errorMessage: string | null;
  /** pending → manual_review 降格時刻 (status=manual_review_required のみ) */
  promotedAt: string | null;
  /** sha256 ハッシュ (ADR-034 PII 最小化) */
  recipientToHash: string;
  /** sha256 配列 (CC) */
  recipientCcHashes: string[];
  /** TTL 期限 (ISO 8601)。claim 時点で claimedAt + 90 days 設定 (ADR-039 OQ #6) */
  ttlExpireAt: string;
}

/**
 * Recipient claim transaction の結果 (内部 service 用、ADR-039 D-3)。
 * `tryClaimProgressRecipient` が返す。
 *  - claimed=true: 新規 pending 作成成功、送信処理に進む
 *  - claimed=false: 既存 doc あり、reason で skip 理由を返す
 */
export type ProgressReportClaimOutcome =
  | { claimed: true }
  | {
      claimed: false;
      reason:
        | "already_sent"
        | "already_failed"
        | "currently_pending_by_other_worker"
        | "pending_lease_expired_promoted_to_manual_review"
        | "already_manual_review_required";
    };

// ============================================================
// Dry-Run DTO (Phase 4 α-7、PR #490 撤廃済型を別名で再導入)
// ============================================================
//
// 進捗レポート + 完了通知の両レーンを **discriminated union** で厳密化。
// PR #490 (2026-05-24) で撤廃された旧 `DryRunResponse` / `DryRunTarget` は
// 同名復活させず、`DispatchDryRunResult` / `CompletionDryRunTarget` 等の
// 別名で再導入する (git log 検索性 + 過去 PR との差別化)。
//
// 関連: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §「PR #490 撤廃理由の解消」
// 関連: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §8 推奨 DTO 例

/**
 * 進捗レポート dry-run の skip 理由 (`skipped === true` のときのみ意味を持つ)。
 *
 * `tenant_doc_not_found` は listAllTenantIds() が tenantId を返したが tenants/{tid}
 * doc が存在しない異常状態。logger 経由で運用者の注意を喚起する。
 */
export type ProgressDryRunSkipReason =
  | "tenant_doc_not_found"
  | "tenant_not_active"
  | "progress_report_disabled"
  | "no_published_courses";

export interface ProgressDryRunTenantSummary {
  tenantId: string;
  skipped: boolean;
  /** `skipped === true` のときのみ設定される */
  skipReason?: ProgressDryRunSkipReason;
  usersScanned: number;
  /** listProgressReportTargetUsers の戻り値そのまま (進捗 1% 以上 + 期限内 + student) */
  candidateCount: number;
  /** email が cc-email-validator で reject された user 数 (送信不能) */
  invalidEmailCount: number;
  /** 100% 完了者 (進捗レーンは skip 対象、AC-PR-02。完了通知レーンがカバー済) */
  completedCount: number;
  /** 実送信対象数 = candidateCount - invalidEmailCount - completedCount */
  wouldSendCount: number;
  /** dedup 後の CC 件数 (ownerEmail + notificationCcEmails) */
  ccCount: number;
}

/** 進捗レポート dry-run の戻り値。`lane: "progress"` で discriminated union のタグ化。 */
export interface ProgressDryRunResult {
  lane: "progress";
  evaluatedAt: string;
  settingsLoaded: boolean;
  settingsSnapshot: {
    progressReportEnabled: boolean;
    scheduleDaysOfWeek: number[];
    scheduleHourJst: number;
    signatureName: string;
  } | null;
  tenantsScanned: number;
  tenantsSummary: ProgressDryRunTenantSummary[];
  /** 全テナント合算の実送信対象数 */
  totalWouldSendCount: number;
  /** 全テナント合算の CC 件数 (To 1 件あたり付与される CC の延べ数) */
  totalCcCount: number;
  /** 推定処理時間 (ミリ秒)、user 並列度 + PDF 生成経験値で算出 */
  estimatedDurationMs: number;
  /** 推定 PDF サイズ範囲 (KB)、PR 3a 以前の draft 経験値 */
  estimatedPdfSizeKbRange: { min: number; typical: number; max: number };
  /** scale trigger: 全テナント合計 300 名超で Cloud Tasks 移行検討 */
  scaleTriggerExceeded: boolean;
}

/**
 * 完了通知 dry-run の skip 理由。
 *
 * 注意: 進捗レポートと異なり `tenant_not_active` / `tenant_doc_not_found` は判定対象外
 * (既存 CLI 挙動と整合、CC config の `completionNotificationEnabled` に統一)。
 */
export type CompletionDryRunSkipReason =
  | "tenant_completion_notification_disabled"
  | "no_published_courses";

/** MIME プレビュー (CC dedup 後の最終形、completion lane のみで生成)。 */
export interface DryRunMimePreview {
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
}

export interface CompletionDryRunTarget {
  tenantId: string;
  userId: string;
  userEmail: string;
  userName: string;
  courseIdsSnapshot: string[];
  mimePreview: DryRunMimePreview;
}

export interface CompletionDryRunTenantSummary {
  tenantId: string;
  skipped: boolean;
  /** `skipped === true` のときのみ設定される */
  skipReason?: CompletionDryRunSkipReason;
  usersScanned: number;
  eligibleCount: number;
}

/** 完了通知 dry-run の戻り値。`lane: "completion"` で discriminated union のタグ化。 */
export interface CompletionDryRunResult {
  lane: "completion";
  evaluatedAt: string;
  settingsLoaded: boolean;
  settingsSnapshot: {
    enabled: boolean;
    scheduleDaysOfWeek: number[];
    scheduleHourJst: number;
    signatureName: string;
    completionMessageBodyLength: number;
  } | null;
  tenantsScanned: number;
  tenantsSummary: CompletionDryRunTenantSummary[];
  wouldNotifyCount: number;
  wouldNotify: CompletionDryRunTarget[];
}

/**
 * 両レーン共通の戻り値型 (discriminated union)。
 *
 * FE 側で `result.lane === "progress"` の type narrowing により
 * `result.totalWouldSendCount` 等の lane 固有 field に安全アクセスできる。
 * `lane` field を必ず先頭で switch することで optional 大量化を避ける。
 */
export type DispatchDryRunResult =
  | ProgressDryRunResult
  | CompletionDryRunResult;

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
  // TEST_SEND_DAILY_LIMIT は 2026-05-24 PR-B で test-send UI 撤廃に伴い削除
  /** Reservation lease 期限 (ミリ秒) */
  RESERVATION_LEASE_MS: 10 * 60 * 1000,
  /** Dispatch run lease 期限 (ミリ秒、Cloud Run 300 秒に余裕) */
  DISPATCH_RUN_LEASE_MS: 280 * 1000,
  /** Audit logs TTL (日) */
  AUDIT_LOGS_TTL_DAYS: 365,
  /** sanitized error message 上限 */
  SANITIZED_ERROR_MESSAGE_MAX_LENGTH: 1024,
  // ↓ Phase 3 進捗レポート定期自動配信 (ADR-039)
  /** 進捗レポート recipient pending lease 期限 (ミリ秒) */
  PROGRESS_REPORT_RECIPIENT_LEASE_MS: 10 * 60 * 1000,
  /** 進捗レポート lane lock lease 期限 (ミリ秒、Cloud Run 300 秒に余裕) */
  PROGRESS_REPORT_LANE_LOCK_LEASE_MS: 280 * 1000,
  /** 進捗レポート recipient TTL (日、ADR-039 OQ #6) */
  PROGRESS_REPORT_RECIPIENT_TTL_DAYS: 90,
  /** 進捗レポート PDF サイズ上限 (バイト、ADR-039 AC-PR-13) */
  PROGRESS_REPORT_PDF_MAX_BYTES: 5 * 1024 * 1024,
  /** 受講中フィルタの最低進捗率 (%、ADR-039 D-5) */
  PROGRESS_REPORT_MIN_PROGRESS_PERCENT: 1,
} as const;
