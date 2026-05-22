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
  type DispatchRun,
  type DispatchRunStatus,
  type DispatchSettings,
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
 * 設定更新入力 (楽観的ロック)。
 *
 * `senderEmail` は env DXCOLLEGE_SENDER_EMAIL 由来の read-only 値だが、doc 初回 create 時に
 * 保存しておく (caller が env から渡す)。GET レスポンス層では env 値で上書きする (NFR-8)。
 * `expectedVersion` は楽観ロック: doc 未作成時は 0 を期待値とする。
 */
export interface UpdateDispatchSettingsInput {
  /** 期待する現在 version。doc 未作成時は 0。不一致で version_conflict */
  expectedVersion: number;
  enabled: boolean;
  scheduleDaysOfWeek: number[];
  scheduleHourJst: number;
  signatureName: string;
  completionMessageBody: string;
  /** env DXCOLLEGE_SENDER_EMAIL (create 時に保存、編集不可) */
  senderEmail: string;
  /** 更新者 email (super admin、raw 保持) */
  updatedBy: string;
  /** 更新時刻 ISO 8601 (テスト時固定可) */
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
}

