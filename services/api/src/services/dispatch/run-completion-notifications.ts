/**
 * DXcollege 自動完了通知メインロジック (Phase 4 統合点)。
 *
 * 設計仕様書 §3.1 全体図、§6.2 送信フロー、FR-1〜FR-12、AC-1〜AC-25 を統合。
 * Phase 1 (pure 関数) + Phase 2 (storage / reservation) + Phase 3 (mail / send)
 * を結合し、Cloud Scheduler 起動 → tenant 走査 → user 送信 → run 完了の
 * end-to-end フローを実装する。
 *
 * 処理順 (設計仕様書 §3.1 ① ~ ⑬):
 *   ① OIDC verify (caller 側 middleware で実施、本関数到達前)
 *   ② run lock 取得 (acquireRunLockOrSkip)
 *   ③ settings 読み取り (storage.getDispatchSettings)
 *   ④ enabled & schedule 一致判定 (shouldRunNow)
 *   ⑤ tenant 走査 (直列、FR-3)
 *   ⑥ user 走査 (並列度 8、Phase 1 LESSON_FETCH_CONCURRENCY と整合)
 *   ⑦ eligibility 判定 (evaluateCompletionEligibility、Critical-2)
 *   ⑧ reservation transaction (tryReserveOrSkip、Critical-1+3)
 *   ⑨ mail build + Gmail send (buildCompletionMail + sendCompletionMail)
 *   ⑩ markSent / markFailedPermanent (status 遷移)
 *   ⑪ audit log (recordAuditLog、PII sanitize 済)
 *   ⑫ run 完了 (completeRun) または abort (abortRun on scope_revoked)
 *
 * caller の責務 (Phase 4 endpoint):
 *   - OIDC verify
 *   - DispatchStorage / TenantDataLoader / env を build して inject
 *   - 返却された結果を internal API response として返す
 */

import { createHash } from "node:crypto";
import {
  type DispatchSettings,
  type RunCompletionNotificationsResponse,
} from "@lms-279/shared-types";

import { shouldRunNow } from "./schedule-matcher.js";
import { evaluateCompletionEligibility } from "./completion-eligibility.js";
import {
  validateAndDedupeCcEmails,
  validateSingleEmail,
} from "./cc-email-validator.js";
import {
  buildCompletionMail,
  DEFAULT_COMPLETION_SUBJECT,
} from "./completion-notification-mail.js";
import {
  isTransientGmailError,
  sendCompletionMail as defaultSendCompletionMail,
  type SendCompletionMailInput,
  type SendCompletionMailResult,
} from "./gmail-dwd-send.js";
import { classifyGmail403 } from "./dispatch-403-classifier.js";
import {
  tryReserveOrSkip,
  markSent,
  markFailedPermanent,
} from "./reservation.js";
import {
  acquireRunLockOrSkip,
  completeRun,
  abortRun,
} from "./run-lock.js";
import { recordAuditLog } from "./dispatch-audit.js";
import { sanitizeErrorForAudit } from "./dispatch-error-sanitizer.js";

import type { DispatchStorage } from "./dispatch-storage.js";
import type {
  TenantDataLoader,
  DispatchTenantDataView,
  TenantCcConfigView,
} from "./tenant-data-loader.js";

/** デフォルト並列度 (FR-3、§3.3 既存 LESSON_FETCH_CONCURRENCY と同値) */
const DEFAULT_USER_CONCURRENCY = 8;

export interface DispatchEnv {
  /** DXCOLLEGE_DISPATCH_SUBJECT (JWT subject = 実 mailbox) */
  subjectEmail: string;
  /** DXCOLLEGE_SENDER_EMAIL (MIME From = SendAs alias) */
  fromEmail: string;
}

export interface RunCompletionNotificationsInput {
  /** caller 生成の runId (uuid v4) */
  runId: string;
  /** 現在時刻 (テスト時固定可) */
  now: Date;
  storage: DispatchStorage;
  loader: TenantDataLoader;
  env: DispatchEnv;
  /** user 並列度 (default DEFAULT_USER_CONCURRENCY=8) */
  userConcurrency?: number;
  /** Gmail send 関数注入点 (テスト時 mock) */
  sendMail?: (
    input: SendCompletionMailInput,
  ) => Promise<SendCompletionMailResult>;
}

/**
 * run 全体中断シグナル (scope_revoked 等の致命的エラー専用)。
 * caller (本関数 / endpoint) で catch して abortRun → 適切な response にマッピング。
 */
export class RunAbortError extends Error {
  constructor(
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(reason, options);
    this.name = "RunAbortError";
  }
}

/**
 * sha256(email) で PII を最小化 (ADR-034、NFR-1)。
 * test からも参照可能にして実装の divergence を防ぐため export (safe-refactor MEDIUM-1)。
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Promise の並列度制御 (簡易 semaphore、外部依存を避ける) */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < effectiveConcurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) break;
          await task(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

interface RunMetrics {
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  manualReviewRequired: number;
}

/**
 * Phase 4 メインロジック。
 *
 * 戻り値: `RunCompletionNotificationsResponse` (Cloud Scheduler への HTTP response)。
 * 戻り値の `runId` は呼び出し時の input.runId とは別: 本関数内で acquire された
 * 場合のみセットされる (lock 拒否時は元 input.runId のままだが skip 扱い)。
 *
 * RunAbortError (scope_revoked) は本関数内で catch して response に reflect する
 * (caller の HTTP endpoint には throw しない、結果として 200 OK + abortedReason)。
 */
export async function runCompletionNotifications(
  input: RunCompletionNotificationsInput,
): Promise<RunCompletionNotificationsResponse> {
  const { runId, now, storage, loader, env } = input;
  const userConcurrency = input.userConcurrency ?? DEFAULT_USER_CONCURRENCY;
  const sendMail = input.sendMail ?? defaultSendCompletionMail;

  // ③ settings 読み取り
  const settings = await storage.getDispatchSettings();
  if (!settings) {
    // 初期化前の状態。kill switch 同等扱いで何もしない。
    return emptyResponse(runId);
  }

  // ④ enabled & schedule 一致判定 (AC-6 / AC-7)
  if (!shouldRunNow(settings, now)) {
    return emptyResponse(runId);
  }

  // ② run lock 取得 (AC-16、Cloud Scheduler 重複起動対策)
  const lockOutcome = await acquireRunLockOrSkip(storage, { now, runId });
  if (!lockOutcome.acquired) {
    return emptyResponse(runId);
  }

  const runStartedAt = lockOutcome.run.triggeredAt;
  await recordAuditLog(storage, {
    runId,
    runStartedAt,
    eventType: "run_started",
    now,
  });

  const metrics: RunMetrics = {
    processedTenants: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    manualReviewRequired: 0,
  };

  try {
    const tenantIds = await loader.listAllTenantIds();
    for (const tenantId of tenantIds) {
      const ccConfig = await loader.getTenantCcConfig(tenantId);
      if (!ccConfig?.completionNotificationEnabled) {
        // テナント単位で disable (tenant config なし or 明示 false)
        continue;
      }
      metrics.processedTenants += 1;

      const dataView = loader.getTenantDataView(tenantId);
      const publishedCourses = await dataView.listPublishedCourses();
      if (publishedCourses.length === 0) {
        // テナントに published コースなし → 全 user 不適格
        continue;
      }
      const users = await dataView.listNotificationTargetUsers();

      await runWithConcurrency(users, userConcurrency, async (user) => {
        await processUser({
          tenantId,
          user,
          publishedCourses,
          ccConfig,
          dataView,
          settings,
          runId,
          runStartedAt,
          now,
          storage,
          env,
          sendMail,
          metrics,
        });
      });
    }

    // ⑫ run 完了
    await completeRun(storage, runId, {
      processedTenants: metrics.processedTenants,
      sent: metrics.sent,
      skipped: metrics.skipped,
      failed: metrics.failed,
      manualReviewRequired: metrics.manualReviewRequired,
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "run_completed",
      now,
    });
    return {
      runId,
      processedTenants: metrics.processedTenants,
      sent: metrics.sent,
      skipped: metrics.skipped,
      failed: metrics.failed,
      manualReviewRequired: metrics.manualReviewRequired,
    };
  } catch (err) {
    // ⑫ scope_revoked 等の致命的エラーで run 全体中断 (AC-17)
    if (err instanceof RunAbortError) {
      await abortRun(storage, runId, err.reason, {
        processedTenants: metrics.processedTenants,
        sent: metrics.sent,
        skipped: metrics.skipped,
        failed: metrics.failed,
        manualReviewRequired: metrics.manualReviewRequired,
      });
      // err.cause は raw object (Gmail API error 等、PII / token を含みうる) のため
      // 明示的に sanitize してから audit log に渡す (safe-refactor HIGH-2 反映)。
      // recordAuditLog 側でも二重 sanitize されるが冪等なので安全。
      const sanitizedCauseMessage = sanitizeErrorForAudit(err.cause ?? err.message);
      await recordAuditLog(storage, {
        runId,
        runStartedAt,
        eventType: "run_aborted",
        errorCode: err.reason,
        errorMessage: sanitizedCauseMessage,
        now,
      });
      return {
        runId,
        processedTenants: metrics.processedTenants,
        sent: metrics.sent,
        skipped: metrics.skipped,
        failed: metrics.failed,
        manualReviewRequired: metrics.manualReviewRequired,
      };
    }
    // 想定外エラーは abort 扱いで上位に伝搬 (caller の HTTP 500 経路へ)
    await abortRun(storage, runId, "unexpected_error", {
      processedTenants: metrics.processedTenants,
      sent: metrics.sent,
      skipped: metrics.skipped,
      failed: metrics.failed,
      manualReviewRequired: metrics.manualReviewRequired,
    });
    throw err;
  }
}

function emptyResponse(runId: string): RunCompletionNotificationsResponse {
  return {
    runId,
    processedTenants: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    manualReviewRequired: 0,
  };
}

interface ProcessUserContext {
  tenantId: string;
  user: { id: string; email: string; name: string | null };
  publishedCourses: Awaited<
    ReturnType<DispatchTenantDataView["listPublishedCourses"]>
  >;
  ccConfig: TenantCcConfigView;
  dataView: DispatchTenantDataView;
  settings: DispatchSettings;
  runId: string;
  runStartedAt: string;
  now: Date;
  storage: DispatchStorage;
  env: DispatchEnv;
  sendMail: (
    input: SendCompletionMailInput,
  ) => Promise<SendCompletionMailResult>;
  metrics: RunMetrics;
}

async function processUser(ctx: ProcessUserContext): Promise<void> {
  const {
    tenantId,
    user,
    publishedCourses,
    ccConfig,
    dataView,
    settings,
    runId,
    runStartedAt,
    now,
    storage,
    env,
    sendMail,
    metrics,
  } = ctx;

  // user.email validation (AC-19)
  const toValidation = validateSingleEmail(user.email);
  if (!toValidation.ok) {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_skipped",
      tenantId,
      userId: user.id,
      errorCode: `invalid_user_email_${toValidation.reason}`,
      now,
    });
    metrics.skipped += 1;
    return;
  }
  const toEmail = toValidation.value;

  // ⑦ eligibility 判定 (AC-1、Critical-2)
  let courseProgresses;
  try {
    courseProgresses = await dataView.listCourseProgressForUser(user.id);
  } catch (err) {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_failed_transient",
      tenantId,
      userId: user.id,
      errorCode: "course_progress_read_failed",
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }
  const eligibility = evaluateCompletionEligibility(
    publishedCourses,
    courseProgresses,
  );
  if (!eligibility.eligible) {
    // 未完了 user は audit に記録せず静かに skip (大量にあるため log spam 防止)
    return;
  }

  // ⑧ reservation transaction (AC-10/11/12)
  const reservation = await tryReserveOrSkip(storage, {
    tenantId,
    userId: user.id,
    runId,
    now,
  });
  if (!reservation.reserved) {
    // 状態別 skip 種別を audit に記録
    if (reservation.reason === "lease_expired_promoted_to_manual_review") {
      metrics.manualReviewRequired += 1;
      await recordAuditLog(storage, {
        runId,
        runStartedAt,
        eventType: "manual_review_required",
        tenantId,
        userId: user.id,
        errorCode: reservation.reason,
        now,
      });
    } else {
      metrics.skipped += 1;
      await recordAuditLog(storage, {
        runId,
        runStartedAt,
        eventType: "user_skipped",
        tenantId,
        userId: user.id,
        errorCode: reservation.reason,
        now,
      });
    }
    return;
  }

  // ⑨ CC validation + mail build
  const ccResult = validateAndDedupeCcEmails(
    ccConfig.notificationCcEmails,
    ccConfig.ownerEmail,
  );
  // CC validation 失敗要素は MIME に含めず audit のみ (orphan_send 相当の警告)
  // 但し sent counter は spec 通り「成功」として進める (AC-25 部分採用)
  if (ccResult.invalidEntries.length > 0) {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_skipped", // 失敗ではなく警告 audit (skip ではないが現行 eventType に該当なし)
      tenantId,
      userId: user.id,
      errorCode: `cc_validation_partial_${ccResult.invalidEntries[0].reason}`,
      now,
    });
    // skipped カウンタには加算しない (audit ログのみ)
  }

  const mail = buildCompletionMail({
    userName: user.name,
    completionMessageBody: settings.completionMessageBody,
    signatureName: settings.signatureName,
  });

  // ⑩ Gmail send → mark sent / failed
  try {
    const sendResult = await sendMail({
      subjectEmail: env.subjectEmail,
      fromEmail: env.fromEmail,
      to: toEmail,
      cc: ccResult.validCcEmails,
      subject: mail.subject,
      body: mail.body,
    });
    await markSent(storage, {
      tenantId,
      userId: user.id,
      messageId: sendResult.messageId,
      notifiedAt: now.toISOString(),
      courseIdsSnapshot: eligibility.courseIdsSnapshot,
      progressSnapshot: eligibility.progressSnapshot,
      recipientToHash: sha256(toEmail),
      recipientCcHashes: ccResult.validCcEmails.map(sha256),
      pdfSizeBytes: null,
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_notified",
      tenantId,
      userId: user.id,
      now,
    });
    metrics.sent += 1;
  } catch (err) {
    await classifyAndRecord({
      err,
      tenantId,
      userId: user.id,
      runId,
      runStartedAt,
      now,
      storage,
      metrics,
    });
  }
}

interface ClassifyContext {
  err: unknown;
  tenantId: string;
  userId: string;
  runId: string;
  runStartedAt: string;
  now: Date;
  storage: DispatchStorage;
  metrics: RunMetrics;
}

async function classifyAndRecord(ctx: ClassifyContext): Promise<void> {
  const { err, tenantId, userId, runId, runStartedAt, now, storage, metrics } =
    ctx;

  // 1. HTTP status 取得
  const status = getHttpStatus(err);

  // 2. 403 → classify scope_revoked vs user_permanent (AC-17, AC-18)
  if (status === 403) {
    const classification = classifyGmail403(err);
    if (classification === "scope_revoked") {
      // run 全体中断 (AC-17)
      throw new RunAbortError("gmail_scope_revoked", { cause: err });
    }
    // user_permanent (AC-18)
    await markFailedPermanent(storage, {
      tenantId,
      userId,
      failedAt: now.toISOString(),
      errorCode: "gmail_user_permanent_403",
      errorMessage: sanitizeErrorForAudit(err),
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_failed_permanent",
      tenantId,
      userId,
      errorCode: "gmail_user_permanent_403",
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }

  // 3. transient (429 / 503 / network) → reservation 維持 (AC-14)
  if (isTransientGmailError(err)) {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_failed_transient",
      tenantId,
      userId,
      errorCode: `gmail_transient_${status ?? "network"}`,
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }

  // 4. それ以外 (400 / 422 / 401 等) → permanent (AC-15)
  await markFailedPermanent(storage, {
    tenantId,
    userId,
    failedAt: now.toISOString(),
    errorCode: `gmail_permanent_${status ?? "unknown"}`,
    errorMessage: sanitizeErrorForAudit(err),
  });
  await recordAuditLog(storage, {
    runId,
    runStartedAt,
    eventType: "user_failed_permanent",
    tenantId,
    userId,
    errorCode: `gmail_permanent_${status ?? "unknown"}`,
    errorMessage: err,
    now,
  });
  metrics.failed += 1;
}

function getHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { response?: { status?: unknown } };
  const status = e.response?.status;
  return typeof status === "number" ? status : null;
}

// re-export 用 (caller が直接参照)
export { DEFAULT_COMPLETION_SUBJECT };
