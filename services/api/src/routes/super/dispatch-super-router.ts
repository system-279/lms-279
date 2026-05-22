/**
 * DXcollege 自動完了通知 スーパー管理者 API の集約ルータ (Phase 5)。
 *
 * 6 endpoint を 1 ルータに束ね、index.ts で superAdminAuthMiddleware 配下に mount する。
 *   GET/PUT /dispatch/settings
 *   GET/PUT /tenants/:tenantId/notification-cc-emails
 *   GET     /dispatch/audit-logs
 *   GET     /dispatch/runs
 *   POST    /dispatch/dry-run
 *   POST    /dispatch/test-send
 *
 * production wiring は dispatch factory (storage/loader/env) を inject。tenant CC store /
 * sendMail / rateLimiter は default 実体を使うが、テストでは差し替え可能。
 */

import { Router, type RequestHandler } from "express";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import type { DispatchEnv } from "../../services/dispatch/run-completion-notifications.js";
import {
  sendCompletionMail,
  type SendCompletionMailInput,
  type SendCompletionMailResult,
} from "../../services/dispatch/gmail-dwd-send.js";
import { testSendLimiter } from "../../middleware/rate-limiter.js";
import { createDispatchSettingsRouter } from "./dispatch-settings.js";
import {
  createTenantNotificationCcRouter,
  FirestoreTenantCcConfigStore,
  type TenantCcConfigStore,
} from "./tenant-notification-cc.js";
import { createDispatchAuditLogsRouter } from "./dispatch-audit-logs.js";
import { createDispatchRunsRouter } from "./dispatch-runs.js";
import { createDispatchDryRunRouter } from "./dispatch-dry-run.js";
import { createDispatchTestSendRouter } from "./dispatch-test-send.js";

export interface DispatchSuperRouterDeps {
  storage: DispatchStorage;
  loader: TenantDataLoader;
  env: DispatchEnv;
  /** tenant CC I/O (default: Firestore) */
  ccStore?: TenantCcConfigStore;
  /** Gmail 送信関数 (default: 本番 DWD 送信) */
  sendMail?: (
    input: SendCompletionMailInput,
  ) => Promise<SendCompletionMailResult>;
  /** test-send レート制限 (default: testSendLimiter 50/日) */
  rateLimiter?: RequestHandler;
}

export function createDispatchSuperRouter(
  deps: DispatchSuperRouterDeps,
): Router {
  const router = Router();

  router.use(
    createDispatchSettingsRouter({
      storage: deps.storage,
      senderEmail: deps.env.fromEmail,
    }),
  );
  router.use(
    createTenantNotificationCcRouter({
      store: deps.ccStore ?? new FirestoreTenantCcConfigStore(),
    }),
  );
  router.use(createDispatchAuditLogsRouter({ storage: deps.storage }));
  router.use(createDispatchRunsRouter({ storage: deps.storage }));
  router.use(
    createDispatchDryRunRouter({ storage: deps.storage, loader: deps.loader }),
  );
  router.use(
    createDispatchTestSendRouter({
      env: deps.env,
      sendMail: deps.sendMail ?? sendCompletionMail,
      rateLimiter: deps.rateLimiter ?? testSendLimiter,
    }),
  );

  return router;
}
