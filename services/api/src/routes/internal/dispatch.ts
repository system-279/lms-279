/**
 * Internal endpoint: Cloud Scheduler 起動による自動完了通知配信 (Phase 4)。
 *
 * 設計仕様書 §3.1 全体図、AC-30 / NFR-2 に対応。
 *
 * Route: POST /api/v2/internal/dispatch/run-completion-notifications
 *
 * 認証: OIDC ID Token (Cloud Scheduler Service Account 発行)。
 * 入力: なし (Body 空)。
 * 出力: RunCompletionNotificationsResponse (sent/skipped/failed 集計)。
 *
 * 製作方針:
 *   - dependency injection で test/prod を切り替える
 *     - test: InMemoryDispatchStorage / InMemoryTenantDataLoader / mock sendMail
 *     - prod: FirestoreDispatchStorage / FirestoreTenantDataLoader を Phase 7 で実装
 *   - 本 module は orchestration を runCompletionNotifications service に完全委譲
 *
 * 想定外エラーは Express の default error handler に伝搬 (500 + ADR-010 形式)。
 * 想定内の "no-op" 結果 (kill switch / schedule 不一致 / run lock 競合) は
 * 200 OK + empty response として返す (Cloud Scheduler は 2xx を成功扱い、retry なし)。
 */

import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import type { RunCompletionNotificationsResponse } from "@lms-279/shared-types";

import {
  requireValidOidcToken,
  type OidcTokenVerifier,
  type RequestWithOidcCaller,
} from "../../services/dispatch/oidc-verify.js";
import {
  runCompletionNotifications,
  type DispatchEnv,
} from "../../services/dispatch/run-completion-notifications.js";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import type { SendCompletionMailInput, SendCompletionMailResult } from "../../services/dispatch/gmail-dwd-send.js";

export interface InternalDispatchRouteConfig {
  /** OIDC audience (Cloud Scheduler 設定の audience と一致させる) */
  expectedAudience: string;
  /** OIDC verifier (本番 GoogleOidcTokenVerifier、test mock) */
  verifier: OidcTokenVerifier;
  storage: DispatchStorage;
  loader: TenantDataLoader;
  env: DispatchEnv;
  /** Gmail send 注入点 (本番 defaultSendCompletionMail、test mock) */
  sendMail?: (input: SendCompletionMailInput) => Promise<SendCompletionMailResult>;
  /** runId 生成器 (test で固定可能) */
  runIdGenerator?: () => string;
  /** Date 注入 (test で固定可能) */
  nowProvider?: () => Date;
}

export function createInternalDispatchRouter(
  config: InternalDispatchRouteConfig,
): Router {
  const router = Router();

  router.post(
    "/dispatch/run-completion-notifications",
    requireValidOidcToken({
      expectedAudience: config.expectedAudience,
      verifier: config.verifier,
    }),
    (req: RequestWithOidcCaller, res: Response): void => {
      const runId = (config.runIdGenerator ?? randomUUID)();
      const now = (config.nowProvider ?? (() => new Date()))();
      void (async () => {
        try {
          const result: RunCompletionNotificationsResponse =
            await runCompletionNotifications({
              runId,
              now,
              storage: config.storage,
              loader: config.loader,
              env: config.env,
              sendMail: config.sendMail,
            });
          res.status(200).json(result);
        } catch (err) {
          // 想定外エラー (storage 障害、loader 障害等)
          // RunAbortError は runCompletionNotifications 内で catch されて response に
          // reflect されるため、ここに来るのは真に想定外のケースのみ
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
