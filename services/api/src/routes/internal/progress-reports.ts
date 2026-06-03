/**
 * Internal endpoint: Cloud Scheduler 起動による進捗レポート定期自動配信 (Phase 3 PR 3c)。
 *
 * 設計仕様書 §4.1、AC-PR-16 / AC-PR-21 対応。
 *
 * Route: POST /api/v2/internal/dispatch/run-progress-reports
 *
 * 認証: OIDC ID Token (Cloud Scheduler Service Account 発行)、completion-notification と共有。
 * 入力: なし (Body 空)。
 * ヘッダ:
 *   - Authorization: Bearer <jwt>
 *   - X-CloudScheduler-ScheduleTime: ISO 8601 (Cloud Scheduler 標準ヘッダ)
 *     occurrenceId 冪等性キーの基にする (AC-PR-06)
 * 出力: RunProgressReportsResponse (sent/skipped/failed/pendingPromotedToManualReview)
 *
 * 製作方針:
 *   - dependency injection で test/prod を切り替える
 *     - test: InMemoryDispatchStorage / InMemoryTenantDataLoader / mock sendRaw / mock pdfBuilder
 *     - prod: FirestoreDispatchStorage / FirestoreTenantDataLoader + production pdfBuilder (factory wiring)
 *   - 本 module は orchestration を runProgressReports service に完全委譲
 *
 * occurrenceId 算出 (ADR-039 D-2):
 *   sha256(`progress\n${X-CloudScheduler-ScheduleTime}`)
 *   → 同 scheduled execution の retry で同一 occurrenceId、別 scheduled execution で別 occurrenceId
 *
 * 想定外エラーは Express の default error handler に伝搬 (500 + ADR-010 形式)。
 * 想定内の "no-op" 結果 (kill switch / schedule 不一致 / lane lock 競合) は
 * 200 OK + empty response として返す (Cloud Scheduler は 2xx を成功扱い、retry なし)。
 */

import { createHash, randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import type { RunProgressReportsResponse } from "@lms-279/shared-types";

import {
  requireValidOidcToken,
  type OidcTokenVerifier,
  type RequestWithOidcCaller,
} from "../../services/dispatch/oidc-verify.js";
import {
  runProgressReports,
  type ProgressReportPdfBuilder,
} from "../../services/dispatch/run-progress-reports.js";
import type { DispatchEnv } from "../../services/dispatch/run-completion-notifications.js";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import type {
  SendCompletionMailResult,
  SendRawMessageInput,
} from "../../services/dispatch/gmail-dwd-send.js";

const CLOUD_SCHEDULER_SCHEDULE_TIME_HEADER = "x-cloudscheduler-scheduletime";

export interface InternalProgressReportsRouteConfig {
  /** OIDC audience (Cloud Scheduler 設定の audience と一致させる) */
  expectedAudience: string;
  /** OIDC verifier (本番 GoogleOidcTokenVerifier、test mock) */
  verifier: OidcTokenVerifier;
  storage: DispatchStorage;
  loader: TenantDataLoader;
  env: DispatchEnv;
  /** PDF 生成 builder (factory で wiring、test では mock) */
  pdfBuilder: ProgressReportPdfBuilder;
  /** raw MIME 送信注入点 (本番 defaultSendRawMessage、test mock) */
  sendRaw?: (input: SendRawMessageInput) => Promise<SendCompletionMailResult>;
  /** runId 生成器 (test で固定可能) */
  runIdGenerator?: () => string;
  /** Date 注入 (test で固定可能) */
  nowProvider?: () => Date;
}

/**
 * occurrenceId 算出 (ADR-039 D-2、Cloud Scheduler at-least-once delivery 対応)。
 * sha256(`progress\n${scheduleTime}`) で同 scheduled execution の retry を冪等化する。
 */
export function computeProgressOccurrenceId(scheduleTime: string): string {
  return createHash("sha256")
    .update(`progress\n${scheduleTime}`)
    .digest("hex");
}

export function createInternalProgressReportsRouter(
  config: InternalProgressReportsRouteConfig,
): Router {
  const router = Router();

  router.post(
    "/dispatch/run-progress-reports",
    requireValidOidcToken({
      expectedAudience: config.expectedAudience,
      verifier: config.verifier,
    }),
    (req: RequestWithOidcCaller, res: Response): void => {
      // X-CloudScheduler-ScheduleTime ヘッダから occurrenceId 算出 (AC-PR-06)。
      // 同ヘッダ不在時は manual invocation / curl 等のケース。Cloud Scheduler 正規経路では
      // 必ず付与されるため不在を 400 で reject (ADR-010 flat error)。
      const scheduleTimeRaw = req.headers[CLOUD_SCHEDULER_SCHEDULE_TIME_HEADER];
      const scheduleTime =
        typeof scheduleTimeRaw === "string"
          ? scheduleTimeRaw.trim()
          : Array.isArray(scheduleTimeRaw)
            ? scheduleTimeRaw[0]?.trim() ?? ""
            : "";
      if (scheduleTime.length === 0) {
        res.status(400).json({
          error: "missing_schedule_time_header",
          message:
            "X-CloudScheduler-ScheduleTime header is required for at-least-once idempotency",
        });
        return;
      }

      const runId = (config.runIdGenerator ?? randomUUID)();
      const now = (config.nowProvider ?? (() => new Date()))();
      const occurrenceId = computeProgressOccurrenceId(scheduleTime);

      void (async () => {
        try {
          const result: RunProgressReportsResponse = await runProgressReports({
            runId,
            occurrenceId,
            now,
            storage: config.storage,
            loader: config.loader,
            env: config.env,
            pdfBuilder: config.pdfBuilder,
            ...(config.sendRaw !== undefined && { sendRaw: config.sendRaw }),
          });
          res.status(200).json(result);
        } catch (err) {
          // 想定外エラー (storage 障害、loader 障害、pdfBuilder 障害等)
          // RunAbortError は runProgressReports 内で catch されて response に reflect されるため、
          // ここに来るのは真に想定外のケースのみ。
          res.status(500).json({
            error: "dispatch_unexpected_error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      })();
    },
  );

  return router;
}
