/**
 * スーパー管理者向け 配信監査ログ取得ルート (Phase 5)。
 *
 * GET /api/v2/super/dispatch/audit-logs
 *   query: tenantId? / userId? / eventType? / from? / to? / limit? / cursor?
 *   200: { logs: DispatchAuditLog[], nextCursor: string | null }
 *
 * storage.listAuditLogs() で全件取得し、route 層で filter + createdAt 降順ソート +
 * cursor paginate する (小規模 + TTL 365 日、composite index 不要)。
 * 認可は親 (index.ts) で superAdminAuthMiddleware 適用済 (AC-31)。
 */

import { Router, type Request, type Response } from "express";
import type {
  DispatchAuditEventType,
  DispatchAuditLog,
  GetAuditLogsResponse,
} from "@lms-279/shared-types";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import { paginateByCursor, resolveLimit } from "./dispatch-pagination.js";

export interface DispatchAuditLogsRouteDeps {
  storage: DispatchStorage;
}

function strParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createDispatchAuditLogsRouter(
  deps: DispatchAuditLogsRouteDeps,
): Router {
  const router = Router();

  router.get(
    "/dispatch/audit-logs",
    async (req: Request, res: Response): Promise<void> => {
      const q = req.query;
      const tenantId = strParam(q.tenantId);
      const userId = strParam(q.userId);
      const eventType = strParam(q.eventType) as
        | DispatchAuditEventType
        | undefined;
      const from = strParam(q.from);
      const to = strParam(q.to);
      const limit = resolveLimit(q.limit);
      const cursor = strParam(q.cursor);

      // storage 側で runId/eventType の絞り込みが可能。残りは route で filter。
      const all = await deps.storage.listAuditLogs(
        eventType ? { eventType } : undefined,
      );

      const fromMs = from ? Date.parse(from) : NaN;
      const toMs = to ? Date.parse(to) : NaN;

      const filtered = all.filter((log: DispatchAuditLog) => {
        if (tenantId && log.tenantId !== tenantId) return false;
        if (userId && log.userId !== userId) return false;
        if (Number.isFinite(fromMs) && Date.parse(log.createdAt) < fromMs) {
          return false;
        }
        if (Number.isFinite(toMs) && Date.parse(log.createdAt) > toMs) {
          return false;
        }
        return true;
      });

      // createdAt 降順、tie-break は auditId 降順 (安定 cursor のため一意キーで決定的に)
      filtered.sort((a, b) => {
        const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (diff !== 0) return diff;
        return b.auditId.localeCompare(a.auditId);
      });

      const { page, nextCursor } = paginateByCursor(
        filtered,
        (log) => log.auditId,
        cursor,
        limit,
      );

      const response: GetAuditLogsResponse = { logs: page, nextCursor };
      res.json(response);
    },
  );

  return router;
}
