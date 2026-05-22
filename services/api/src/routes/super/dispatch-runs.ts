/**
 * スーパー管理者向け 配信 run 履歴取得ルート (Phase 5)。
 *
 * GET /api/v2/super/dispatch/runs
 *   query: limit? / cursor?
 *   200: { runs: DispatchRun[], nextCursor: string | null }
 *
 * storage.listRuns() で全件取得し、triggeredAt 降順ソート + cursor paginate する
 * (小規模 + TTL 365 日、composite index 不要)。
 * 認可は親 (index.ts) で superAdminAuthMiddleware 適用済 (AC-31)。
 */

import { Router, type Request, type Response } from "express";
import type { GetRunsResponse } from "@lms-279/shared-types";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import { paginateByCursor, resolveLimit } from "./dispatch-pagination.js";

export interface DispatchRunsRouteDeps {
  storage: DispatchStorage;
}

function strParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createDispatchRunsRouter(
  deps: DispatchRunsRouteDeps,
): Router {
  const router = Router();

  router.get(
    "/dispatch/runs",
    async (req: Request, res: Response): Promise<void> => {
      const limit = resolveLimit(req.query.limit);
      const cursor = strParam(req.query.cursor);

      const all = await deps.storage.listRuns();

      // triggeredAt 降順、tie-break は runId 降順 (安定 cursor)
      all.sort((a, b) => {
        const diff = Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt);
        if (diff !== 0) return diff;
        return b.runId.localeCompare(a.runId);
      });

      const { page, nextCursor } = paginateByCursor(
        all,
        (run) => run.runId,
        cursor,
        limit,
      );

      const response: GetRunsResponse = { runs: page, nextCursor };
      res.json(response);
    },
  );

  return router;
}
