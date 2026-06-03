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

import {
  DISPATCH_CONSTRAINTS,
  type CompletionNotification,
  type DispatchAuditLog,
  type DispatchLane,
  type DispatchLaneLock,
  type DispatchRun,
  type DispatchRunStatus,
  type DispatchSettings,
  type ProgressReportClaimOutcome,
  type ProgressReportRecipient,
  type ProgressReportSettings,
  type ReservationOutcome,
} from "@lms-279/shared-types";

/**
 * audit log / dispatch run の TTL (ミリ秒、365 日)。
 * run-lock.ts / dispatch-audit.ts から共通参照される (重複定義回避)。
 */
export const DISPATCH_AUDIT_TTL_MS =
  DISPATCH_CONSTRAINTS.AUDIT_LOGS_TTL_DAYS * 24 * 60 * 60 * 1000;

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
  /**
   * 配信レーン識別子 (Phase 3、ADR-039 D-1)。
   * 完了通知レーンは undefined で呼び出し可 (後方互換、storage 実装は欠落時 "completion" 扱い)。
   * 進捗レポートレーンは "progress" を必須で渡す。
   *
   * 注意: lane 内の重複 run 検査は本 method ではなく `acquireLaneLock` 側で別 doc
   * (`super_dispatch_lane_locks/{laneId}`) で行う。本 method の重複検査は
   * runId 単位の duplicate のみ (既存挙動不変)。
   */
  laneId?: DispatchLane;
  /**
   * Cloud Scheduler at-least-once delivery 対応の冪等性キー (Phase 3、ADR-039 D-2)。
   * 進捗レポートレーンのみ設定 (完了通知レーンでは undefined)。
   * sha256(laneId + X-CloudScheduler-ScheduleTime) で算出され、同 scheduled execution の
   * retry を冪等化する。本 method では run doc に書き込むだけで、recipient 単位の
   * 冪等性は `tryClaimProgressRecipient` 側で別途担保する。
   */
  occurrenceId?: string;
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
  /** manual_review_required に降格された user 数 (Phase 4 追加) */
  manualReviewRequired?: number;
  /** aborted 時の理由 (sanitized) */
  abortedReason?: string;
}

// ============================================================
// Lane lock (super_dispatch_lane_locks/{laneId}) — Phase 3 ADR-039 D-4
// ============================================================

/**
 * Lane lock acquire 入力。
 *
 * 既存 `acquireRunLock` (super_dispatch_runs/{runId} 単位の重複検査) と異なり、
 * lane 単位の排他を別 doc (`super_dispatch_lane_locks/{laneId}`) で transactional
 * に取得する (ADR-039 D-4、Codex CRITICAL-3 反映: 完了通知レーンの run-lock の
 * query→set best-effort では同 lane 並行 request の race を解消できない)。
 *
 * 完了通知レーンは Phase 3 で互換維持のため lane lock を導入せず、Phase 4 で統合検討。
 * 進捗レポートレーンのみ本 method を使用する。
 */
export interface AcquireLaneLockInput {
  laneId: DispatchLane;
  /** 現在 lock を取得しようとしている run の ID */
  ownerRunId: string;
  /**
   * Cloud Scheduler 冪等性キー (進捗レポートレーンで設定、完了通知では undefined)。
   * 本 method 自体は同 laneId 内の重複取得を防ぐだけで、occurrence 単位の冪等性は
   * `tryClaimProgressRecipient` 側で recipient doc が担保する。
   */
  occurrenceId?: string;
  /** 現在時刻 (ISO 8601、テスト時固定可) */
  now: string;
  /** lease 有効期限 (now + PROGRESS_REPORT_LANE_LOCK_LEASE_MS、ISO 8601) */
  leaseExpiresAt: string;
}

export type AcquireLaneLockOutcome =
  | { acquired: true; lock: DispatchLaneLock }
  | {
      acquired: false;
      /** 既存 lock の lease 期限内で他 run 保持中 */
      reason: "lane_lock_held_by_other_run";
      /** 競合相手の lock 状態 (audit/監視用) */
      currentLock: DispatchLaneLock;
    };

export interface CompleteLaneLockInput {
  laneId: DispatchLane;
  /**
   * 取得時の runId (実装契約: 一致時のみ削除、Codex MEDIUM 反映)。
   * 不一致なら no-op (lease 切れ後に新 run が再取得した lock を古い run が消さない)。
   */
  ownerRunId: string;
}

export interface AbortLaneLockInput {
  laneId: DispatchLane;
  /** 取得時の runId (不一致なら no-op、completeLaneLock と同じ契約) */
  ownerRunId: string;
  /** abort 理由 (sanitized) */
  abortedReason: string;
}

// ============================================================
// Progress recipient (tenants/{tenantId}/progress_report_sends/{occurrenceId}__{userId})
// Phase 3 ADR-039 D-3 (Codex CRITICAL-2 反映: state machine 化)
// ============================================================

/**
 * Recipient claim 試行入力。
 *
 * 設計仕様書 §4.1 主フロー擬似コード、AC-PR-06/07/08/17 対応。
 * doc id は `${occurrenceId}__${userId}` (occurrence 単位の at-most-once attempt 保証)。
 *
 * **claim 時点で設定する field** (markSent/markFailed まで不変):
 *   - status=pending / claimedAt / leaseExpiresAt / ttlExpireAt / runId / occurrenceId
 *
 * **PII (recipientToHash / recipientCcHashes) は markProgressRecipientSent 時点で設定**
 *   完了通知レーンと同じ pattern (claim 時は宛先未確定の case があるため、send 直前
 *   validation 後に確定した hash を保存する)。
 */
export interface ClaimProgressRecipientInput {
  tenantId: string;
  userId: string;
  /** Cloud Scheduler 冪等性キー (ADR-039 D-2) */
  occurrenceId: string;
  /** HTTP attempt 単位の監査用 UUID */
  runId: string;
  /** 現在時刻 (ISO 8601、テスト時固定可) */
  now: string;
  /** Lease 期限 (now + PROGRESS_REPORT_RECIPIENT_LEASE_MS、ISO 8601) */
  leaseExpiresAt: string;
  /**
   * TTL 期限 (now + PROGRESS_REPORT_RECIPIENT_TTL_DAYS、ISO 8601)。
   * AC-PR-17: claim 時点で必ず設定 (90 日後、Firestore TTL policy で自動削除)。
   */
  ttlExpireAt: string;
}

/**
 * 送信成功時の status=sent 遷移入力。
 *
 * **三者一致 precondition (Codex HIGH-2 反映)**:
 *   既存 doc の `status=pending` かつ `occurrenceId` / `runId` が input と一致するときのみ
 *   更新可能。不一致 (lease 切れ降格後の stale finalize / 別 occurrence の上書き) は throw。
 */
export interface MarkProgressRecipientSentInput {
  tenantId: string;
  userId: string;
  /** precondition: 既存 doc の occurrenceId と一致必須 */
  occurrenceId: string;
  /** precondition: 既存 doc の runId と一致必須 */
  runId: string;
  /** 送信成功時刻 (ISO 8601) */
  sentAt: string;
  /** Gmail API messageId */
  messageId: string;
  /** PDF 添付サイズ (バイト) */
  pdfSizeBytes: number;
  /** 受講者 email の sha256 (ADR-034、PII 最小化) */
  recipientToHash: string;
  /** CC email 配列の sha256 (順序保持) */
  recipientCcHashes: string[];
}

/**
 * Permanent 失敗時の status=failed 遷移入力。
 * 三者一致 precondition は `MarkProgressRecipientSentInput` と同じ (pending + occurrenceId + runId)。
 */
export interface MarkProgressRecipientFailedInput {
  tenantId: string;
  userId: string;
  occurrenceId: string;
  runId: string;
  /** 失敗時刻 (ISO 8601) */
  failedAt: string;
  /** sanitized error code (caller 責務) */
  errorCode: string;
  /** sanitized error message (caller 責務、PII 含まない) */
  errorMessage: string;
  /**
   * 失敗時の宛先 hash (任意、PII 監査用)。
   * 失敗が validation 段階で起きた場合は undefined を許容する。
   */
  recipientToHash?: string;
  recipientCcHashes?: string[];
}

/**
 * pending → manual_review_required 降格入力 (AC-PR-07)。
 *
 * 実装契約:
 *   - precondition: status=pending のみ降格対象。他 status は throw (idempotency より一貫性優先)
 *   - lease 切れ検知 (`tryClaimProgressRecipient` 内で旧 doc を見つけたとき or 別 sweep) から呼ぶ
 *   - runId / occurrenceId 一致 check は本 method 単独では不要 (claim 内 transaction で識別済)
 */
export interface PromotePendingToManualReviewInput {
  tenantId: string;
  userId: string;
  /** どの occurrence の recipient を降格するか */
  occurrenceId: string;
  /** 降格時刻 (ISO 8601) */
  promotedAt: string;
}

/** Recipient 単純取得入力 (主にテスト / dry-run / 監査用) */
export interface GetProgressRecipientInput {
  tenantId: string;
  userId: string;
  occurrenceId: string;
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
// Settings update (super_dispatch_settings/global、Phase 5 super-admin API)
// ============================================================

/**
 * 設定更新入力 (楽観的ロック + patch semantics、Phase 3 ADR-039 HIGH-4 反映)。
 *
 * **patch semantics** (Codex Plan stage review 反映):
 *   `expectedVersion` / `updatedBy` / `updatedAt` 以外は全 optional。
 *   storage 実装は未指定 (undefined) field を既存値で保持する merge を行う。
 *   これにより:
 *   - 旧 UI 経由の PUT (`progressReport` 欠落) で既存 `progressReport` が消えない
 *   - 将来の field 追加で旧クライアントとの後方互換が破れない
 *
 * **初回 create バリデーション (route 層責務、storage 不参照)**:
 *   doc 未作成時 (expectedVersion=0) は route handler 側で必須 field 揃いを検証する:
 *   - enabled / scheduleDaysOfWeek / scheduleHourJst / signatureName /
 *     completionMessageBody / senderEmail
 *   storage 層は patch merge のみ責任を負い、defaults 補完はしない。
 *
 * `senderEmail` は env DXCOLLEGE_SENDER_EMAIL 由来の read-only 値。doc 初回 create 時のみ
 * 保存する (route handler が env から渡す)。更新時は undefined で既存値保持。
 * GET レスポンス層では env 値で上書きする (NFR-8)。
 *
 * `expectedVersion` は楽観ロック: doc 未作成時は 0 を期待値とする。
 */
export interface UpdateDispatchSettingsInput {
  /** 期待する現在 version。doc 未作成時は 0。不一致で version_conflict */
  expectedVersion: number;
  /** undefined で既存値保持 (patch semantics) */
  enabled?: boolean;
  scheduleDaysOfWeek?: number[];
  scheduleHourJst?: number;
  signatureName?: string;
  completionMessageBody?: string;
  /**
   * Phase 3 進捗レポート設定 (ADR-039 HIGH-4)。
   * undefined で既存値保持。明示的な無効化は `{ enabled: false, ... }` を送る。
   * 本 PR (3a) では設定 UI 未実装のため、本 field を含む PUT は実質発生しない。
   */
  progressReport?: ProgressReportSettings;
  /**
   * env DXCOLLEGE_SENDER_EMAIL。doc 未作成時のみ必要 (route 層で create 判定して渡す)。
   * 更新時は undefined で既存値保持 (read-only field)。
   */
  senderEmail?: string;
  /** 更新者 email (super admin、raw 保持、毎回必須) */
  updatedBy: string;
  /** 更新時刻 ISO 8601 (テスト時固定可、毎回必須) */
  updatedAt: string;
}

export type UpdateDispatchSettingsOutcome =
  | { updated: true; settings: DispatchSettings }
  | {
      updated: false;
      reason: "version_conflict";
      /** UI reload 用の現在値 (doc 未作成なら null) */
      current: DispatchSettings | null;
    };

// ============================================================
// DispatchStorage interface
// ============================================================

export interface DispatchStorage {
  // ----- Settings -----
  /**
   * super_dispatch_settings/global の読み取り。
   * doc が存在しなければ null を返す (Phase 7 で初期化される想定)。
   *
   * Phase 5 super-admin API で settings 編集 (PUT) を追加するが、本 interface は
   * Phase 4 では read-only のみ公開 (write は別 method を Phase 5 で追加)。
   */
  getDispatchSettings(): Promise<DispatchSettings | null>;

  /**
   * super_dispatch_settings/global の更新 (Phase 5 super-admin PUT)。
   *
   * 楽観的ロック (version): `expectedVersion` が現在 version と一致しなければ
   * `version_conflict` を返す (doc 未作成時の現在 version は 0 とみなす)。一致時は
   * version を +1 して書き込み、更新後の DispatchSettings を返す。
   *
   * 実装契約 (atomicity 必須): read version → 一致判定 → write を atomic に行う
   * (Firestore: runTransaction、InMemory: await を挟まない同期実行)。並行 PUT で
   * version チェックをすり抜けた lost update を防ぐ。
   */
  updateDispatchSettings(
    input: UpdateDispatchSettingsInput,
  ): Promise<UpdateDispatchSettingsOutcome>;

  // ----- Reservation -----
  /**
   * Pre-send reservation を transactional に取得する。
   *
   * 設計仕様書 §6.2 (Reservation 方式)、AC-10/11/12、FR-7 改訂、NFR-3 改訂 対応。
   *
   * **実装契約 (atomicity 必須)**:
   *   本操作全体は **atomic transaction** で実行すること。
   *   - Firestore 実装: `db.runTransaction(...)` で「status 読み取り → 既存 state 判定
   *     → 降格 update / 新規 create」を 1 transaction 内に包む。read-modify-write の
   *     間に他 worker の write が割り込まないことを保証する。
   *   - InMemory 実装: Node.js single-threaded 性質を活かし、本 method 実行中に
   *     `await` を挟まないことで atomicity を担保する (event loop 上では同期実行)。
   *   atomicity が破られると、2 並列 worker が `lease_expired_promoted_to_manual_review`
   *   を同時検出して両方が降格 update を発火し、二重送信 → 二重 sent 確定の事故に
   *   繋がる (Codex Critical-1+3 の中核)。
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

  /**
   * 送信成功時の status=sent 遷移 + sent fields 更新 (FR-12 含む snapshot 保存)。
   *
   * 実装契約:
   *   - 呼び出し時に既存 record が `status=reserved` であることを前提とする
   *     (caller が `tryReserveCompletionNotification` で reserved=true を取得済)
   *   - 既存 record の status が "reserved" 以外 (sent / failed_permanent /
   *     manual_review_required) の場合は throw する。これは caller の状態管理
   *     不整合を早期検出する意図 (idempotency より一貫性優先)。
   *   - Firestore 実装で網起こりうる partial-failure retry シナリオ
   *     (write timeout 後の status 不確実) では、caller 側で再 reserve を試行
   *     し reservation outcome (already_sent 等) で skip するフローを推奨する。
   */
  markCompletionNotificationSent(input: MarkSentInput): Promise<void>;

  /**
   * Permanent 失敗時の status=failed_permanent 遷移 + error fields 更新。
   * 状態遷移契約は markCompletionNotificationSent と同様 (reserved → failed_permanent)。
   */
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

  /**
   * Run 全件取得 (Phase 5 super-admin runs 一覧 API)。
   * 並び替え・ページネーションは route 層で行う (小規模 + TTL 365 日でデータ量限定的なため
   * 全件取得 + in-memory paginate を採用、composite index 不要)。
   */
  listRuns(): Promise<DispatchRun[]>;

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

  // ----- Lane lock (Phase 3, ADR-039 D-4) -----
  /**
   * Lane lock を transactional に取得する。
   *
   * 設計仕様書 §4.1 主フロー、AC-PR-09 (lane lock transactional 排他) 対応。
   *
   * **実装契約 (atomicity 必須)**:
   *   `super_dispatch_lane_locks/{laneId}` を tx.get → lease 判定 → tx.set で atomic に
   *   取得する。
   *   - Firestore 実装: `db.runTransaction(...)` 内で「読み取り → 判定 → 書き込み」を
   *     1 transaction に包む。read-modify-write の間に他 worker の write が割り込まない
   *     ことを保証する (Codex CRITICAL-3 の中核)
   *   - InMemory 実装: Node.js single-threaded を活かし await を挟まない同期実行
   *
   * 戻り値:
   *   - acquired=true: 既存 lock なし or lease 切れで新規取得成功
   *   - acquired=false + reason=lane_lock_held_by_other_run: 既存 lock の lease 期限内
   *     (currentLock を併せて返し、caller 側で audit に記録)
   */
  acquireLaneLock(input: AcquireLaneLockInput): Promise<AcquireLaneLockOutcome>;

  /**
   * Lane lock の正常解放 (run 正常完了時)。
   *
   * **実装契約**:
   *   - 既存 lock の `ownerRunId` が input の `ownerRunId` と一致するときのみ削除
   *   - 不一致 (lease 切れ後に新 run が再取得済 / lock 自体が存在しない) → no-op
   *   - これにより古い run が新 run の lock を消す事故を防ぐ (Codex MEDIUM 反映)
   *
   * 戻り値なし: caller は単に await すればよい (no-op でも throw しない)。
   */
  completeLaneLock(input: CompleteLaneLockInput): Promise<void>;

  /**
   * Lane lock の abort 経路での解放 (例: RunAbortError catch 後)。
   *
   * `completeLaneLock` との違いは `abortedReason` を audit に残せる点のみ。
   * ownerRunId 不一致時の挙動は同じ (no-op)。
   */
  abortLaneLock(input: AbortLaneLockInput): Promise<void>;

  // ----- Progress recipient state machine (Phase 3, ADR-039 D-3) -----
  /**
   * Recipient claim を transactional に取得する。
   *
   * 設計仕様書 §4.1 主フロー、AC-PR-06 (occurrenceId 冪等) / AC-PR-07 (pending lease 切れ) /
   * AC-PR-08 (別 occurrence で再 claim) / AC-PR-17 (TTL claim 時設定) 対応。
   *
   * **実装契約 (atomicity 必須)**:
   *   `tenants/{tenantId}/progress_report_sends/{occurrenceId}__{userId}` を
   *   tx.get → 既存 state 判定 → 降格 update / 新規 create で 1 transaction に包む。
   *   - 既存 doc なし: status=pending で新規 create、`ttlExpireAt` も同 transaction で設定
   *     → `{ claimed: true }` を返す
   *   - status=pending かつ lease 期限切れ: 同 transaction で `manual_review_required` に
   *     降格 → `{ claimed: false, reason: "pending_lease_expired_promoted_to_manual_review" }`
   *   - status=pending かつ lease 期限内: `{ claimed: false, reason: "currently_pending_by_other_worker" }`
   *   - status=sent: `{ claimed: false, reason: "already_sent" }` (AC-PR-06 冪等性)
   *   - status=failed: `{ claimed: false, reason: "already_failed" }`
   *   - status=manual_review_required: `{ claimed: false, reason: "already_manual_review_required" }`
   *
   * **重要**: 既存 doc が「別 runId / 別 occurrence」を含むケースは doc id 設計上発生しない
   * (occurrenceId が doc id 一部のため別 occurrence は別 doc になる)。
   */
  tryClaimProgressRecipient(
    input: ClaimProgressRecipientInput,
  ): Promise<ProgressReportClaimOutcome>;

  /**
   * Recipient の status=sent 遷移 + sent fields 更新。
   *
   * **三者一致 precondition (Codex HIGH-2 反映)**:
   *   既存 doc が以下を全て満たすときのみ更新可能、いずれか不一致なら throw:
   *   - status === "pending"
   *   - occurrenceId === input.occurrenceId
   *   - runId === input.runId
   *
   * これにより以下を防ぐ:
   *   - lease 切れ降格後の status=manual_review_required を sent で上書きする stale finalize
   *   - 別 occurrence の recipient を誤って上書き
   *   - 別 run (lease 切れ後の retry など) が claim した recipient を別 run が finalize
   *
   * 実装は Firestore runTransaction / InMemory 同期処理で precondition check を含めて atomic 化。
   */
  markProgressRecipientSent(
    input: MarkProgressRecipientSentInput,
  ): Promise<void>;

  /**
   * Recipient の status=failed 遷移 + error fields 更新。
   * 三者一致 precondition は `markProgressRecipientSent` と同じ。
   */
  markProgressRecipientFailed(
    input: MarkProgressRecipientFailedInput,
  ): Promise<void>;

  /**
   * pending → manual_review_required 降格 (AC-PR-07)。
   *
   * 実装契約:
   *   - precondition: 既存 doc の status=pending のみ降格対象
   *   - 他 status (sent / failed / 既に manual_review_required / doc 自体不在) → throw
   *
   * 通常は `tryClaimProgressRecipient` 内 transaction で lease 切れ降格が同時に行われるため、
   * 本 method 単独呼び出しは少ない (将来の background sweep 用)。
   */
  promotePendingToManualReview(
    input: PromotePendingToManualReviewInput,
  ): Promise<void>;

  /**
   * Recipient の単純取得 (テスト / dry-run / audit 用)。
   * 通常の業務ロジックでは `tryClaimProgressRecipient` → `markProgressRecipientSent/Failed`
   * フローで使用し、本 method は読み取り専用。doc 未存在で null を返す。
   */
  getProgressRecipient(
    input: GetProgressRecipientInput,
  ): Promise<ProgressReportRecipient | null>;
}

