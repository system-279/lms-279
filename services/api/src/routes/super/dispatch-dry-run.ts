/**
 * スーパー管理者向け dispatch dry-run 取得ルート (Phase 4 α-7 C1)。
 *
 * GET /api/v2/super/dispatch/dry-run/progress
 *   200: ProgressDryRunResult (DispatchDryRunResult discriminated union の "progress" variant)
 * GET /api/v2/super/dispatch/dry-run/completion
 *   200: CompletionDryRunResult (DispatchDryRunResult discriminated union の "completion" variant)
 *
 * いずれも:
 *   - 認可: 親 router で superAdminAuthMiddleware 適用 (AC-α7-05)
 *   - レート制限: dispatchDryRunLimiter (10 req/min/superAdminEmail、AC-α7-12)
 *   - 重複制御: lane 単位 single-flight (進行中は結果共有で Firestore read 抑制)
 *   - read-only: Firestore write / Gmail send / PDF 実生成なし (AC-α7-06)
 *   - test-send 経路を含まない (PR #490 撤廃方針維持)
 *
 * Phase 4 α-7 C2 で dispatch-super-router.ts から mount される。
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク C1
 *   - PR #490 撤廃理由の解消: 同 impl-plan §「PR #490 撤廃理由の解消」
 *   - 過去の同名 route (PR #490 で削除): services/api/src/routes/super/dispatch-dry-run.ts
 *     (本ファイルは別設計 (両レーン対応 / discriminated union / 専用 limiter / single-flight) で再導入)
 */

import { Router, type Request, type RequestHandler, type Response } from "express";
import type { DispatchDryRunResult } from "@lms-279/shared-types";

import { dispatchDryRunLimiter } from "../../middleware/dispatch-dry-run-limiter.js";
import { runProgressReportDryRun } from "../../services/dispatch/dry-run/progress-report-dry-run.js";
import { runCompletionNotificationDryRun } from "../../services/dispatch/dry-run/completion-notification-dry-run.js";
import {
  sharedDispatchDryRunSingleFlight,
  type DispatchDryRunSingleFlight,
} from "../../services/dispatch/dry-run/single-flight.js";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";

export interface DispatchDryRunRouteDeps {
  storage: DispatchStorage;
  loader: TenantDataLoader;
  /** 完了通知 dry-run の MIME From アドレス (環境変数から index.ts で読み取り inject) */
  senderEmail: string;
  /**
   * test では独立 single-flight instance を inject 可能。
   * production / 通常は省略して module スコープ singleton を使用。
   */
  singleFlight?: DispatchDryRunSingleFlight;
  /**
   * test では noop or 独立 limiter instance を inject 可能 (module スコープ
   * `dispatchDryRunLimiter` は process スコープ state を持ち test 間で残るため)。
   * production / 通常は省略して default `dispatchDryRunLimiter` を使用。
   */
  limiter?: RequestHandler;
}

export function createDispatchDryRunRouter(
  deps: DispatchDryRunRouteDeps,
): Router {
  const router = Router();
  const sf = deps.singleFlight ?? sharedDispatchDryRunSingleFlight;
  const limiter = deps.limiter ?? dispatchDryRunLimiter;

  router.get(
    "/dispatch/dry-run/progress",
    limiter,
    async (_req: Request, res: Response): Promise<void> => {
      const result: DispatchDryRunResult = await sf.run("progress", () =>
        runProgressReportDryRun({
          storage: deps.storage,
          loader: deps.loader,
          now: new Date(),
          // logger は省略 (default NOOP)、Phase 4 後続で構造化 logger 注入を検討
        }),
      );
      res.json(result);
    },
  );

  router.get(
    "/dispatch/dry-run/completion",
    limiter,
    async (_req: Request, res: Response): Promise<void> => {
      const result: DispatchDryRunResult = await sf.run("completion", () =>
        runCompletionNotificationDryRun({
          storage: deps.storage,
          loader: deps.loader,
          senderEmail: deps.senderEmail,
          now: new Date(),
        }),
      );
      res.json(result);
    },
  );

  return router;
}
