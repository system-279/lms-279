/**
 * DXcollege 自動完了通知 スーパー管理者 API の集約ルータ (Phase 5)。
 *
 * 4 endpoint を 1 ルータに束ね、index.ts で superAdminAuthMiddleware 配下に mount する。
 *   GET/PUT /dispatch/settings
 *   GET/PUT /tenants/:tenantId/notification-cc-emails
 *   GET     /dispatch/audit-logs
 *   GET     /dispatch/runs
 *
 * 旧 POST /dispatch/dry-run / /dispatch/test-send は 2026-05-24 PR-B で撤廃済み:
 *   - dry-run の代替は `.github/workflows/dispatch-dry-run.yml` + `scripts/dispatch-dry-run-cli.ts`
 *     (admin SDK workflow_dispatch、UI ボタン撤廃方針)
 *   - test-send は SendAs send smoke (`smoke-dwd-gmail-send.yml`) と本機能本体の
 *     monitoring で代替 (固定 dummy 送信は cutover 時の検証で完了済)
 *
 * production wiring は dispatch factory (storage/loader/env) を inject。
 * tenant CC store は default 実体を使うが、テストでは差し替え可能。
 */

import { Router } from "express";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { DispatchEnv } from "../../services/dispatch/run-completion-notifications.js";
import { createDispatchSettingsRouter } from "./dispatch-settings.js";
import {
  createTenantNotificationCcRouter,
  FirestoreTenantCcConfigStore,
  type TenantCcConfigStore,
} from "./tenant-notification-cc.js";
import { createDispatchAuditLogsRouter } from "./dispatch-audit-logs.js";
import { createDispatchRunsRouter } from "./dispatch-runs.js";

export interface DispatchSuperRouterDeps {
  storage: DispatchStorage;
  env: DispatchEnv;
  /** tenant CC I/O (default: Firestore) */
  ccStore?: TenantCcConfigStore;
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

  return router;
}
