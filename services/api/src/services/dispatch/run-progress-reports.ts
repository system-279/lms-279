/**
 * DXcollege 進捗レポート定期自動配信メインロジック (Phase 3 PR 3c、ADR-039)。
 *
 * 設計仕様書 §4.1、AC-PR-01 〜 AC-PR-22 を統合。
 * run-completion-notifications.ts (完了通知レーン) の対称設計だが以下の違いがある:
 *   - lane lock (acquireLaneLockOrSkip with laneId="progress") を使用 (Codex CRITICAL-3 反映)
 *   - occurrenceId を caller (endpoint route) から受け取る (Cloud Scheduler at-least-once 冪等性)
 *   - shouldRunProgressReportNow で progressReport sub-schedule を判定
 *   - tenant filter: active + progressReportEnabled (AC-PR-03 / AC-PR-04)
 *   - user filter: listProgressReportTargetUsers (Plan A 4 軸、ADR-039 D-5)
 *   - eligibility 判定は「100% 完了は除外」 (AC-PR-02、完了通知と逆論理)
 *   - recipient state machine (occurrenceId × userId、90 日 TTL) を使用
 *   - PDF 添付ありの multipart/mixed MIME を progress-mime-builder で構築
 *
 * 処理順 (設計仕様書 §4.1):
 *   ① OIDC verify (caller endpoint で実施、本関数到達前)
 *   ② occurrenceId / runId 算出 (caller endpoint)
 *   ③ settings 読み取り (storage.getDispatchSettings)
 *   ④ progressReport sub-schedule 一致判定 (shouldRunProgressReportNow)
 *   ⑤ lane lock 取得 (acquireLaneLockOrSkip、laneId=progress)
 *   ⑥ tenant 走査 (直列): active + progressReportEnabled=true のみ
 *   ⑦ user 走査 (並列度 8、listProgressReportTargetUsers から取得)
 *   ⑧ eligibility 判定 (100% 完了 → user_skipped_completed)
 *   ⑨ recipient claim (tryClaimRecipientOrSkip)
 *   ⑩ pdfBuilder で PDF 生成 + 5MB 上限判定 (AC-PR-13)
 *   ⑪ MIME build (buildProgressReportMime) + sendRawMessage
 *   ⑫ markRecipientSent / markRecipientFailed
 *   ⑬ audit log (eventType 9 種、PII sanitize 済)
 *   ⑭ completeLaneLock または abortLaneLock (RunAbortError 経路)
 */

import { createHash } from "node:crypto";
import type {
  DispatchSettings,
  ProgressPdfData,
  RunProgressReportsResponse,
} from "@lms-279/shared-types";

import { shouldRunProgressReportNow } from "./schedule-matcher.js";
import { evaluateCompletionEligibility } from "./completion-eligibility.js";
import {
  validateAndDedupeCcEmails,
  validateSingleEmail,
} from "./cc-email-validator.js";
import {
  isTransientGmailError,
  sendRawMessage as defaultSendRawMessage,
  type SendCompletionMailResult,
  type SendRawMessageInput,
} from "./gmail-dwd-send.js";
import { classifyGmail403 } from "./dispatch-403-classifier.js";
import {
  acquireLaneLockOrSkip,
  completeLaneLock,
  abortLaneLock,
} from "./lane-lock.js";
import {
  markRecipientFailed,
  markRecipientSent,
  tryClaimRecipientOrSkip,
} from "./progress-report-recipient.js";
import { buildProgressReportMime } from "./progress-mime-builder.js";
import { recordAuditLog } from "./dispatch-audit.js";
import { sanitizeErrorForAudit } from "./dispatch-error-sanitizer.js";
import { RunAbortError, type DispatchEnv } from "./run-completion-notifications.js";

import type { DispatchStorage } from "./dispatch-storage.js";
import type {
  DispatchTenantDataView,
  TenantCcConfigView,
  TenantDataLoader,
} from "./tenant-data-loader.js";

/** デフォルト並列度 (FR-3 / §3.3、完了通知レーンと整合) */
const DEFAULT_USER_CONCURRENCY = 8;

// re-export: caller の RunAbortError import 経路を一本化
export { RunAbortError } from "./run-completion-notifications.js";

/**
 * PDF 生成 builder の input (run-progress-reports からの呼び出し時に渡す値)。
 * tenant doc + DataSource からの aggregation は builder 実装側で行う。
 */
export interface ProgressReportPdfBuilderInput {
  tenantId: string;
  user: { id: string; email: string; name: string | null };
  /** 現在時刻 (テスト時固定可) */
  now: Date;
}

/**
 * PDF 生成 builder の result。
 *   - kind="ready": PDF 生成成功、`pdfData.tenant.name / ownerEmail` を含む
 *   - kind="pdf_too_large": 5MB 超過 (AC-PR-13)、専用 skip 経路へ
 */
export type ProgressReportPdfBuilderResult =
  | { kind: "ready"; pdfData: ProgressPdfData; pdfBuffer: Buffer }
  | { kind: "pdf_too_large"; sizeBytes: number };

/**
 * PDF 生成 builder。
 *
 * test: フィクスチャから ProgressPdfData / 固定 Buffer を返す mock。
 * prod (factory wiring): `getDataSource({tenantId, isDemo: false})` + tenant doc 読み取り +
 *   `buildProgressPdfData` + `ProgressPdfDocument` + `renderToBuffer` + size check の wrapper。
 *
 * 5MB 上限判定は本 builder 内で行う (AC-PR-13、`PROGRESS_REPORT_PDF_MAX_BYTES`)。
 * caller は `kind="pdf_too_large"` を受けたら skip + audit + 専用 counter で記録する。
 */
export type ProgressReportPdfBuilder = (
  input: ProgressReportPdfBuilderInput,
) => Promise<ProgressReportPdfBuilderResult>;

export interface RunProgressReportsInput {
  /** caller 生成の runId (uuid v4) */
  runId: string;
  /** Cloud Scheduler at-least-once 冪等性キー (sha256(laneId + ScheduleTime)) */
  occurrenceId: string;
  /** 現在時刻 (テスト時固定可) */
  now: Date;
  storage: DispatchStorage;
  loader: TenantDataLoader;
  env: DispatchEnv;
  pdfBuilder: ProgressReportPdfBuilder;
  /** user 並列度 (default DEFAULT_USER_CONCURRENCY=8) */
  userConcurrency?: number;
  /** raw MIME 送信注入点 (テスト時 mock) */
  sendRaw?: (input: SendRawMessageInput) => Promise<SendCompletionMailResult>;
}

/**
 * sha256(email) で PII を最小化 (ADR-034、NFR-1)。test からも参照可能。
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

interface ProgressMetrics {
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  pendingPromotedToManualReview: number;
}

function emptyResponse(
  runId: string,
  occurrenceId: string,
  laneLockContention = false,
): RunProgressReportsResponse {
  return {
    runId,
    occurrenceId,
    processedTenants: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    pendingPromotedToManualReview: 0,
    laneLockContention,
  };
}

function responseFromMetrics(
  runId: string,
  occurrenceId: string,
  metrics: ProgressMetrics,
): RunProgressReportsResponse {
  return {
    runId,
    occurrenceId,
    processedTenants: metrics.processedTenants,
    sent: metrics.sent,
    skipped: metrics.skipped,
    failed: metrics.failed,
    pendingPromotedToManualReview: metrics.pendingPromotedToManualReview,
    laneLockContention: false,
  };
}

/**
 * Phase 3 PR 3c メインロジック。
 *
 * 戻り値: `RunProgressReportsResponse` (Cloud Scheduler への HTTP response)。
 * RunAbortError (scope_revoked) は本関数内で catch して response に reflect する
 * (caller の HTTP endpoint には throw しない、結果として 200 OK + 計測値)。
 */
export async function runProgressReports(
  input: RunProgressReportsInput,
): Promise<RunProgressReportsResponse> {
  const { runId, occurrenceId, now, storage, loader, env, pdfBuilder } = input;
  const sendRaw = input.sendRaw ?? defaultSendRawMessage;
  const userConcurrency = input.userConcurrency ?? DEFAULT_USER_CONCURRENCY;

  // ③ settings 読み取り
  const settings = await storage.getDispatchSettings();
  if (!settings) {
    // 初期化前は何もしない (kill switch 同等)
    return emptyResponse(runId, occurrenceId);
  }

  // ④ progressReport sub-schedule 判定 (AC-PR-05 / AC-PR-22)
  if (!shouldRunProgressReportNow(settings.progressReport, now)) {
    return emptyResponse(runId, occurrenceId);
  }

  // ⑤ lane lock 取得 (AC-PR-09)
  const lockOutcome = await acquireLaneLockOrSkip(storage, {
    laneId: "progress",
    ownerRunId: runId,
    occurrenceId,
    now,
  });
  if (!lockOutcome.acquired) {
    // 競合: laneLockContention=true + audit (Cloud Scheduler は 200 で完了扱い)
    const runStartedAtForAudit = now.toISOString();
    await recordAuditLog(storage, {
      runId,
      runStartedAt: runStartedAtForAudit,
      eventType: "lane_lock_contention",
      errorCode: "lane_lock_held_by_other_run",
      now,
    });
    return emptyResponse(runId, occurrenceId, true);
  }

  const runStartedAt = lockOutcome.lock.acquiredAt;
  await recordAuditLog(storage, {
    runId,
    runStartedAt,
    eventType: "progress_report_run_started",
    now,
  });

  const metrics: ProgressMetrics = {
    processedTenants: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    pendingPromotedToManualReview: 0,
  };

  try {
    const tenantIds = await loader.listAllTenantIds();
    for (const tenantId of tenantIds) {
      // ⑥ tenant filter: active + progressReportEnabled (AC-PR-04)
      const tenantInfo = await loader.getTenantInfo(tenantId);
      if (!tenantInfo?.active) continue;
      if (!tenantInfo.progressReportEnabled) continue;

      // CC 設定 (null でも進捗レポートは送信、To 単独可、AC-PR-11 設定独立性)
      const ccConfig = await loader.getTenantCcConfig(tenantId);

      metrics.processedTenants += 1;

      const dataView = loader.getTenantDataView(tenantId);
      // tenant 不変の publishedCourses を tenant ループで 1 回 fetch し、
      // user 並列ループの各 worker に共有 (code-review #4 反映: N+1 Firestore read 削減、
      // 完了通知レーン run-completion-notifications.ts L213 と同パターン)。
      // 独立 I/O のため listProgressReportTargetUsers と Promise.all で並列化。
      const [publishedCourses, users] = await Promise.all([
        dataView.listPublishedCourses(),
        dataView.listProgressReportTargetUsers(now),
      ]);

      // ⑦ user 並列度 8 (FR-3)
      await runWithConcurrency(users, userConcurrency, async (user) => {
        await processProgressUser({
          tenantId,
          user,
          publishedCourses,
          ccConfig,
          dataView,
          settings,
          runId,
          runStartedAt,
          occurrenceId,
          now,
          storage,
          env,
          pdfBuilder,
          sendRaw,
          metrics,
        });
      });
    }

    // ⑭ run 完了 — durationMs を audit log に記録 (evaluator AC-PR-21 反映)。
    // runStartedAt は lane lock acquire 時刻 ISO 8601、now は本関数の処理時間軸。
    const runDurationMs = now.getTime() - new Date(runStartedAt).getTime();
    await completeLaneLock(storage, "progress", runId);
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "progress_report_run_completed",
      durationMs: runDurationMs,
      now,
    });
    return responseFromMetrics(runId, occurrenceId, metrics);
  } catch (err) {
    // abort 経路でも duration を記録 (evaluator AC-PR-21 反映、完了通知レーンと整合)
    const abortDurationMs = now.getTime() - new Date(runStartedAt).getTime();
    if (err instanceof RunAbortError) {
      await abortLaneLock(storage, "progress", runId, err.reason);
      // err.cause は raw object (Gmail API error 等、PII / token を含みうる) のため
      // 明示的に sanitize してから audit log に渡す (完了通知レーンと同パターン)。
      const sanitizedCauseMessage = sanitizeErrorForAudit(err.cause ?? err.message);
      await recordAuditLog(storage, {
        runId,
        runStartedAt,
        eventType: "progress_report_run_aborted",
        errorCode: err.reason,
        errorMessage: sanitizedCauseMessage,
        durationMs: abortDurationMs,
        now,
      });
      return responseFromMetrics(runId, occurrenceId, metrics);
    }
    // 想定外エラーの abort 経路: lock 解放 + audit 記録 (code-review #8 反映、
    // 完了通知レーンとの対称性確保。errorMessage は evaluator LOW 反映で明示 sanitize、
    // run-completion-notifications.ts L274 の pattern と統一)
    await abortLaneLock(storage, "progress", runId, "unexpected_error");
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "progress_report_run_aborted",
      errorCode: "unexpected_error",
      errorMessage: sanitizeErrorForAudit(err),
      durationMs: abortDurationMs,
      now,
    });
    throw err;
  }
}

interface ProcessProgressUserContext {
  tenantId: string;
  user: { id: string; email: string; name: string | null };
  /** tenant 単位 1 回 fetch 済の published コース一覧 (caller が tenant ループで hoist 済) */
  publishedCourses: Awaited<
    ReturnType<DispatchTenantDataView["listPublishedCourses"]>
  >;
  ccConfig: TenantCcConfigView | null;
  dataView: DispatchTenantDataView;
  settings: DispatchSettings;
  runId: string;
  runStartedAt: string;
  occurrenceId: string;
  now: Date;
  storage: DispatchStorage;
  env: DispatchEnv;
  pdfBuilder: ProgressReportPdfBuilder;
  sendRaw: (input: SendRawMessageInput) => Promise<SendCompletionMailResult>;
  metrics: ProgressMetrics;
}

async function processProgressUser(ctx: ProcessProgressUserContext): Promise<void> {
  const {
    tenantId,
    user,
    publishedCourses,
    ccConfig,
    dataView,
    settings,
    runId,
    runStartedAt,
    occurrenceId,
    now,
    storage,
    env,
    pdfBuilder,
    sendRaw,
    metrics,
  } = ctx;

  // user.email validation
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

  // ⑧ eligibility 判定 (AC-PR-02: 100% 完了は除外)
  // code-review #1 反映: evaluateCompletionEligibility は `eligible: false` を多数の
  // 異常状態 (no_published_courses / missing_progress / malformed_progress /
  // lesson_count_mismatch / malformed_course) でも返す。これら不整合状態で進捗レポート
  // 送信に進むと壊れた PDF を配信するため、明示的に skip + audit する。
  let courseProgresses;
  try {
    courseProgresses = await dataView.listCourseProgressForUser(user.id);
  } catch (err) {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_skipped",
      tenantId,
      userId: user.id,
      errorCode: "course_progress_read_failed",
      errorMessage: err,
      now,
    });
    metrics.skipped += 1;
    return;
  }
  // publishedCourses は caller の tenant ループで hoist 済 (code-review #4 反映、
  // N+1 read 削減、完了通知レーンと同パターン)
  const eligibility = evaluateCompletionEligibility(publishedCourses, courseProgresses);
  if (eligibility.eligible) {
    // 100% 完了者は除外 (完了通知レーンの送信対象、本レーンでは skip)
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_skipped_completed",
      tenantId,
      userId: user.id,
      now,
    });
    metrics.skipped += 1;
    return;
  }
  // eligible=false の異常状態 (no_published_courses / missing_progress 等) は受講中
  // ではない / データ不整合 → 進捗レポート送信せず skip + audit (code-review #1 反映)。
  // "not_completed" のみが本来の「受講中 = 送信対象」状態で、それ以外は send 不適格。
  if (eligibility.reason !== "not_completed") {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_skipped",
      tenantId,
      userId: user.id,
      errorCode: `eligibility_${eligibility.reason}`,
      now,
    });
    metrics.skipped += 1;
    return;
  }

  // ⑨ recipient claim (AC-PR-06 / AC-PR-07 / AC-PR-08 / AC-PR-17)
  const claimOutcome = await tryClaimRecipientOrSkip(storage, {
    tenantId,
    userId: user.id,
    occurrenceId,
    runId,
    now,
  });
  if (!claimOutcome.claimed) {
    if (claimOutcome.reason === "pending_lease_expired_promoted_to_manual_review") {
      metrics.pendingPromotedToManualReview += 1;
      await recordAuditLog(storage, {
        runId,
        runStartedAt,
        eventType: "pending_promoted_to_manual_review",
        tenantId,
        userId: user.id,
        errorCode: claimOutcome.reason,
        now,
      });
    } else {
      metrics.skipped += 1;
      // already_sent は冪等 skip のため audit 抑止 (log spam 防止)
      if (claimOutcome.reason !== "already_sent") {
        await recordAuditLog(storage, {
          runId,
          runStartedAt,
          eventType: "user_skipped",
          tenantId,
          userId: user.id,
          errorCode: claimOutcome.reason,
          now,
        });
      }
    }
    return;
  }

  // ⑩ PDF 生成
  let builderResult: ProgressReportPdfBuilderResult;
  try {
    builderResult = await pdfBuilder({ tenantId, user, now });
  } catch (err) {
    // PDF 生成失敗 → markFailed + audit
    await markRecipientFailed(storage, {
      tenantId,
      userId: user.id,
      occurrenceId,
      runId,
      failedAt: now.toISOString(),
      errorCode: "pdf_generation_failed",
      errorMessage: sanitizeErrorForAudit(err),
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "progress_report_failed",
      tenantId,
      userId: user.id,
      errorCode: "pdf_generation_failed",
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }

  if (builderResult.kind === "pdf_too_large") {
    // AC-PR-13: skip + 専用 audit (failed counter 不変、専用 counter)
    // recipient state は failed (errorCode=pdf_too_large) にして pending 滞留を防ぐ。
    await markRecipientFailed(storage, {
      tenantId,
      userId: user.id,
      occurrenceId,
      runId,
      failedAt: now.toISOString(),
      errorCode: "pdf_too_large",
      errorMessage: `pdfSizeBytes=${builderResult.sizeBytes}`,
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "pdf_too_large",
      tenantId,
      userId: user.id,
      errorCode: "pdf_too_large",
      errorMessage: `pdfSizeBytes=${builderResult.sizeBytes}`,
      now,
    });
    metrics.skipped += 1; // AC-PR-13: 専用 counter (failed カウンタ不変)
    return;
  }

  const { pdfData, pdfBuffer } = builderResult;

  // ⑪ CC validation + MIME build
  const ownerEmail = pdfData.tenant.ownerEmail;
  const ccCandidates = ccConfig?.notificationCcEmails ?? [];
  const ccResult = validateAndDedupeCcEmails(ccCandidates, ownerEmail);
  if (ccResult.invalidEntries.length > 0) {
    // 無効 CC は MIME に含めず audit のみ (完了通知レーンと同パターン)
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "user_skipped",
      tenantId,
      userId: user.id,
      errorCode: `cc_validation_partial_${ccResult.invalidEntries[0].reason}`,
      now,
    });
    // skipped カウンタには加算しない (audit のみ、送信は継続)
  }

  let mimeOutput;
  try {
    mimeOutput = buildProgressReportMime({
      pdfData,
      pdfBuffer,
      fromEmail: env.fromEmail,
      toEmail,
      ccEmails: ccResult.validCcEmails,
      senderName: settings.signatureName,
      // ccNoteEmail は trim 後空文字を弾く (code-review #7 反映、defense-in-depth)。
      // progress-mime-builder docstring (L44-46) と buildMailTemplate 内部の二重防御に
      // 加えて caller 側でも明示的に gate し、空 owner email で半端な注記が出るのを防ぐ。
      ...(ownerEmail !== null &&
        ownerEmail.trim().length > 0 && { ccNoteEmail: ownerEmail }),
    });
  } catch (err) {
    // MIME build 失敗 (CRLF injection / quoted-string injection 等の防御層 throw)
    await markRecipientFailed(storage, {
      tenantId,
      userId: user.id,
      occurrenceId,
      runId,
      failedAt: now.toISOString(),
      errorCode: "mime_build_failed",
      errorMessage: sanitizeErrorForAudit(err),
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "progress_report_failed",
      tenantId,
      userId: user.id,
      errorCode: "mime_build_failed",
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }

  // ⑫ Gmail send → markSent / markFailed
  // code-review #2 反映: sendRaw 成功後 (= Gmail 既に送信済み) の markRecipientSent /
  // recordAuditLog の precondition 違反 (lease 切れ race で別 worker が manual_review に
  // 降格させた等) を gmail send 失敗の catch に流すと classifyAndRecordProgress 経由で
  // 二重送信リスクが生じる。send 成功後の post-send book-keeping は別 try で分離し、
  // post-send 失敗を audit に残しつつ run abort へ伝搬しない (orphan_send 相当扱い)。
  let sendResult: SendCompletionMailResult;
  try {
    sendResult = await sendRaw({
      subjectEmail: env.subjectEmail,
      fromEmail: env.fromEmail,
      raw: mimeOutput.raw,
    });
  } catch (err) {
    await classifyAndRecordProgress({
      err,
      tenantId,
      userId: user.id,
      occurrenceId,
      runId,
      runStartedAt,
      now,
      storage,
      metrics,
    });
    return;
  }

  // send 成功後の post-send book-keeping (markSent precondition / audit log)。
  // Gmail には既に送信済みなので、本ブロック内の throw は run abort に伝搬させず
  // orphan_send audit のみ記録して metrics.sent += 1 に進める (受講者は受信済)。
  try {
    await markRecipientSent(storage, {
      tenantId,
      userId: user.id,
      occurrenceId,
      runId,
      sentAt: now.toISOString(),
      messageId: sendResult.messageId,
      pdfSizeBytes: pdfBuffer.length,
      recipientToHash: sha256(toEmail),
      recipientCcHashes: ccResult.validCcEmails.map(sha256),
    });
  } catch (err) {
    // markRecipientSent の precondition 失敗 (lease 切れ race 等)。Gmail には送信済なので
    // markFailed もせず orphan_send audit のみ。Gmail messageId は audit に残せず errorMessage
    // で sanitize 経由で記録。code-review #2 反映。
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "orphan_send",
      tenantId,
      userId: user.id,
      errorCode: "marksent_precondition_failed_after_send",
      errorMessage: err,
      now,
    });
    metrics.sent += 1;
    return;
  }
  // markSent 成功 → 通常 sent audit (code-review #3 反映: durationMs に attempts を
  // 渡していた誤用を削除。durationMs はミリ秒を意図する field、attempts は retry 回数で
  // 意味論不一致。完了通知レーンと整合させる)。
  await recordAuditLog(storage, {
    runId,
    runStartedAt,
    eventType: "progress_report_sent",
    tenantId,
    userId: user.id,
    now,
  });
  void sendResult.attempts; // 将来 audit metadata 追加時に活用予定 (現状未使用)
  metrics.sent += 1;
}

interface ClassifyProgressContext {
  err: unknown;
  tenantId: string;
  userId: string;
  occurrenceId: string;
  runId: string;
  runStartedAt: string;
  now: Date;
  storage: DispatchStorage;
  metrics: ProgressMetrics;
}

async function classifyAndRecordProgress(
  ctx: ClassifyProgressContext,
): Promise<void> {
  const { err, tenantId, userId, occurrenceId, runId, runStartedAt, now, storage, metrics } = ctx;
  const status = getHttpStatus(err);

  // 403 → classify scope_revoked vs user_permanent (AC-PR-21)
  if (status === 403) {
    const classification = classifyGmail403(err);
    if (classification === "scope_revoked") {
      // run 全体中断
      throw new RunAbortError("gmail_scope_revoked", { cause: err });
    }
    await markRecipientFailed(storage, {
      tenantId,
      userId,
      occurrenceId,
      runId,
      failedAt: now.toISOString(),
      errorCode: "gmail_user_permanent_403",
      errorMessage: sanitizeErrorForAudit(err),
    });
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "progress_report_failed",
      tenantId,
      userId,
      errorCode: "gmail_user_permanent_403",
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }

  // transient (429 / 503 / network) → recipient pending 維持 (lease 切れまで次 retry で再 claim 可)
  // AC-PR-20: 429 retry は gmail-dwd-send 内で実施済、本経路は MAX_ATTEMPTS 全部尽きた後
  if (isTransientGmailError(err)) {
    await recordAuditLog(storage, {
      runId,
      runStartedAt,
      eventType: "progress_report_failed",
      tenantId,
      userId,
      errorCode: `gmail_transient_${status ?? "network"}`,
      errorMessage: err,
      now,
    });
    metrics.failed += 1;
    return;
  }

  // それ以外 (400 / 422 / 401 等) → permanent
  await markRecipientFailed(storage, {
    tenantId,
    userId,
    occurrenceId,
    runId,
    failedAt: now.toISOString(),
    errorCode: `gmail_permanent_${status ?? "unknown"}`,
    errorMessage: sanitizeErrorForAudit(err),
  });
  await recordAuditLog(storage, {
    runId,
    runStartedAt,
    eventType: "progress_report_failed",
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
