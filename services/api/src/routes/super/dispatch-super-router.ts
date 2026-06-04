/**
 * DXcollege 配信 スーパー管理者 API の集約ルータ (Phase 5、Phase 4 α-7 で dry-run 再導入)。
 *
 * 6 endpoint を 1 ルータに束ね、index.ts で superAdminAuthMiddleware 配下に mount する。
 *   GET/PUT /dispatch/settings
 *   GET/PUT /tenants/:tenantId/notification-cc-emails
 *   GET     /dispatch/audit-logs
 *   GET     /dispatch/runs
 *   GET     /dispatch/dry-run/progress      (Phase 4 α-7 で追加)
 *   GET     /dispatch/dry-run/completion    (Phase 4 α-7 で追加)
 *
 * dry-run UI 再導入の経緯 (2026-06-03 開発者決裁):
 *   2026-05-24 PR #490 で dry-run UI / API は「UI に残すと誤操作リスク」「AI 代替経路で十分」
 *   との判断で撤廃。Phase 3 進捗レポート機能の本格 cutover + 業務スーパー管理者の自律的
 *   運用フェーズへの移行に伴い「画面で事前確認できないと運用リスク」が顕在化したため、
 *   下記の前提変化を満たす範囲で再導入:
 *     - read-only viewer 限定 (test-send 機能は再導入しない)
 *     - 専用 limiter (10 req/min/superAdminEmail) + lane 単位 single-flight で抑制
 *     - 両レーン同時 UI 化 (UX 統一)
 *   詳細: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §「PR #490 撤廃理由の解消」
 *
 * 旧 POST /dispatch/test-send は引き続き撤廃 (再導入しない、PR #490 撤廃方針を維持)。
 * 旧 dry-run の代替 workflow は引き続き運用継続 (AI / 開発者向け):
 *   - `.github/workflows/dispatch-dry-run.yml`
 *   - `.github/workflows/progress-report-dry-run.yml`
 *
 * production wiring は dispatch factory (storage/loader/env) を inject。
 * tenant CC store は default 実体を使うが、テストでは差し替え可能。
 */

import { Router } from "express";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import type { DispatchEnv } from "../../services/dispatch/run-completion-notifications.js";
import { createDispatchSettingsRouter } from "./dispatch-settings.js";
import {
  createTenantNotificationCcRouter,
  FirestoreTenantCcConfigStore,
  type TenantCcConfigStore,
} from "./tenant-notification-cc.js";
import { createDispatchAuditLogsRouter } from "./dispatch-audit-logs.js";
import { createDispatchRunsRouter } from "./dispatch-runs.js";
import { createDispatchDryRunRouter } from "./dispatch-dry-run.js";

export interface DispatchSuperRouterDeps {
  storage: DispatchStorage;
  /** Phase 4 α-7 で dry-run UI 再導入に伴い deps に復活 (PR #490 撤廃時に削除されていた) */
  loader: TenantDataLoader;
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
  router.use(
    createDispatchDryRunRouter({
      storage: deps.storage,
      loader: deps.loader,
      senderEmail: deps.env.fromEmail,
    }),
  );

  return router;
}
