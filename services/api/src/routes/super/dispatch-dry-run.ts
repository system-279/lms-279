/**
 * スーパー管理者向け 配信ドライランルート (Phase 5)。
 *
 * POST /api/v2/super/dispatch/dry-run
 *   200: { wouldNotify: DryRunTarget[], evaluatedAt }
 *
 * 次回 cron で送信される対象 (100% 完了 & email 有効 & 未通知) を返す。
 * AC-8: Gmail 送信も Reservation も実行しない (getCompletionNotification の read のみ)。
 * schedule / enabled は無視し eligibility のみで評価する (プレビュー目的)。
 * 認可は親 (index.ts) で superAdminAuthMiddleware 適用済 (AC-31)。
 */

import { Router, type Request, type Response } from "express";
import type { DryRunResponse, DryRunTarget } from "@lms-279/shared-types";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import { evaluateCompletionEligibility } from "../../services/dispatch/completion-eligibility.js";
import { validateSingleEmail } from "../../services/dispatch/cc-email-validator.js";

export interface DispatchDryRunRouteDeps {
  storage: DispatchStorage;
  loader: TenantDataLoader;
  /** evaluatedAt 用 now provider (テスト時固定可) */
  now?: () => Date;
}

export function createDispatchDryRunRouter(
  deps: DispatchDryRunRouteDeps,
): Router {
  const router = Router();
  const now = deps.now ?? ((): Date => new Date());

  router.post(
    "/dispatch/dry-run",
    async (_req: Request, res: Response): Promise<void> => {
      const wouldNotify: DryRunTarget[] = [];
      const tenantIds = await deps.loader.listAllTenantIds();

      for (const tenantId of tenantIds) {
        const ccConfig = await deps.loader.getTenantCcConfig(tenantId);
        // テナント単位 disable は対象外 (run ロジックと整合)
        if (!ccConfig?.completionNotificationEnabled) continue;

        const dataView = deps.loader.getTenantDataView(tenantId);
        const publishedCourses = await dataView.listPublishedCourses();
        if (publishedCourses.length === 0) continue;

        const users = await dataView.listNotificationTargetUsers();
        for (const user of users) {
          // email 無効はどのみち送信されない (AC-19)
          const emailV = validateSingleEmail(user.email);
          if (!emailV.ok) continue;

          const progresses = await dataView.listCourseProgressForUser(user.id);
          const eligibility = evaluateCompletionEligibility(
            publishedCourses,
            progresses,
          );
          if (!eligibility.eligible) continue;

          // 既存 notification (sent/reserved/failed/manual) は次回 cron で再送されない
          const existing = await deps.storage.getCompletionNotification(
            tenantId,
            user.id,
          );
          if (existing) continue;

          wouldNotify.push({
            tenantId,
            userId: user.id,
            userEmail: emailV.value,
            userName: user.name ?? "",
            progressSnapshot: eligibility.progressSnapshot,
          });
        }
      }

      const response: DryRunResponse = {
        wouldNotify,
        evaluatedAt: now().toISOString(),
      };
      res.json(response);
    },
  );

  return router;
}
