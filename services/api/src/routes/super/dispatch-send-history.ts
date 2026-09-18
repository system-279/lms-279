/**
 * スーパー管理者向け 送信実績一覧取得ルート (PR2a、配信可視化)。
 *
 * GET /api/v2/super/dispatch/send-history
 *   query: lane? ("completion"|"progress") / tenantId? / limit? / cursor?
 *   200: GetSendHistoryResponse { items: SendHistoryEntry[], nextCursor: string | null }
 *
 * 認可は親 (index.ts) で superAdminAuthMiddleware 適用済み (AC-31 と同型)。
 *
 * ## 設計 (PR2a、Fable レビュー反映済み)
 *
 * `completion_notifications` / `progress_report_sends` は `tenants/{tenantId}/...`
 * のテナント別サブコレクションであり、テナント横断の一覧取得には collectionGroup クエリの
 * 前例がこのリポジトリに無いため、**テナント×レーンの「シャード」単位で個別取得し
 * アプリ層でマージソートする keyset 方式**を採る。
 *
 * シャード = (tenantId, lane) の組。各シャードから `storage.listSendHistoryShard()` で
 * 最大 limit 件を processedAt 降順で取得し、全シャードの候補をマージソートして上位 limit 件を
 * ページとして返す。各シャードの次回カーソルは「このページで実際に消費した最後の要素」まで
 * 進める (消費されなかった候補は次ページで同じカーソルから再取得される、正しさを保つための
 * 意図的な非効率 — シャード数は現状 8 (テナント4 × レーン2) 程度で許容範囲)。
 *
 * 受講者の氏名・メールアドレスは `completion_notifications`/`progress_report_sends` 自体には
 * 保存されていない (ADR-034 PII 最小化、sha256 ハッシュのみ)。userId から
 * `loader.getTenantDataView(tenantId).getUsersByIds()` でバッチ join する。
 */

import { Router, type Request, type Response } from "express";
import type {
  DispatchLane,
  GetSendHistoryResponse,
  SendHistoryEntry,
} from "@lms-279/shared-types";
import type {
  DispatchStorage,
  SendHistoryShardCursor,
  SendHistoryShardItem,
} from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import { resolveLimit } from "./dispatch-pagination.js";

export interface DispatchSendHistoryRouteDeps {
  storage: DispatchStorage;
  loader: TenantDataLoader;
}

const LANES: DispatchLane[] = ["completion", "progress"];

function shardKey(tenantId: string, lane: DispatchLane): string {
  return `${tenantId}::${lane}`;
}

function strParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function laneParam(value: unknown): DispatchLane | undefined {
  return value === "completion" || value === "progress" ? value : undefined;
}

/** opaque cursor = base64(JSON.stringify({ [shardKey]: SendHistoryShardCursor })) */
type ShardCursorMap = Record<string, SendHistoryShardCursor>;

function decodeCursor(raw: string | undefined): ShardCursorMap {
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as ShardCursorMap;
    }
    return {};
  } catch {
    // 不正な cursor は「先頭から」に fallback (dispatch-pagination.ts の
    // 「cursor 不明時は空ページ+null で終端扱い」とは異なり、こちらは複数シャード合成
    // カーソルのため単純に先頭から再開する方が UX 上安全)
    return {};
  }
}

function encodeCursor(map: ShardCursorMap): string {
  return Buffer.from(JSON.stringify(map), "utf-8").toString("base64url");
}

export function createDispatchSendHistoryRouter(
  deps: DispatchSendHistoryRouteDeps,
): Router {
  const router = Router();

  router.get(
    "/dispatch/send-history",
    async (req: Request, res: Response): Promise<void> => {
      const limit = resolveLimit(req.query.limit);
      const laneFilter = laneParam(req.query.lane);
      const tenantIdFilter = strParam(req.query.tenantId);
      const cursorMap = decodeCursor(strParam(req.query.cursor));

      const lanes = laneFilter ? [laneFilter] : LANES;
      const tenantIds = tenantIdFilter
        ? [tenantIdFilter]
        : await deps.loader.listAllTenantIds();

      // 各シャードから候補を取得 (シャード数 = tenantIds.length × lanes.length)
      const shardFetches: {
        tenantId: string;
        lane: DispatchLane;
        items: SendHistoryShardItem[];
      }[] = await Promise.all(
        tenantIds.flatMap((tenantId) =>
          lanes.map(async (lane) => {
            const after = cursorMap[shardKey(tenantId, lane)];
            const items = await deps.storage.listSendHistoryShard({
              tenantId,
              lane,
              limit,
              after,
            });
            return { tenantId, lane, items };
          }),
        ),
      );

      // 全シャード候補をマージし processedAt desc, docId desc でソート
      const merged = shardFetches
        .flatMap((s) => s.items)
        .sort((a, b) => {
          if (a.processedAt !== b.processedAt) {
            return a.processedAt < b.processedAt ? 1 : -1;
          }
          return a.docId < b.docId ? 1 : a.docId > b.docId ? -1 : 0;
        });

      const page = merged.slice(0, limit);

      // 次カーソル: シャードごとに「このページで実際に消費した最後の要素」まで進める。
      // 未消費なら incoming cursor を維持 (次ページで同じ範囲を再取得、取りこぼし防止)。
      const nextCursorMap: ShardCursorMap = { ...cursorMap };
      let hasMore = false;
      for (const { tenantId, lane, items } of shardFetches) {
        const key = shardKey(tenantId, lane);
        const consumedFromShard = page.filter(
          (p) => p.tenantId === tenantId && p.lane === lane,
        );
        if (consumedFromShard.length > 0) {
          const last = consumedFromShard[consumedFromShard.length - 1];
          nextCursorMap[key] = { processedAt: last.processedAt, docId: last.docId };
        }
        // シャードの fetch が limit 件ちょうど返した = まだ先がある可能性
        if (items.length === limit) hasMore = true;
        // このシャードで fetch した候補のうち page に含まれなかったものがある = 未消費が残っている
        if (consumedFromShard.length < items.length) hasMore = true;
      }

      // tenantName / userName / userEmail の join
      const tenantNameCache = new Map<string, string>();
      async function resolveTenantName(tenantId: string): Promise<string> {
        const cached = tenantNameCache.get(tenantId);
        if (cached) return cached;
        const info = await deps.loader.getTenantInfo(tenantId);
        const name = info?.name ?? tenantId;
        tenantNameCache.set(tenantId, name);
        return name;
      }

      const userIdsByTenant = new Map<string, Set<string>>();
      for (const item of page) {
        const set = userIdsByTenant.get(item.tenantId) ?? new Set<string>();
        set.add(item.userId);
        userIdsByTenant.set(item.tenantId, set);
      }
      const userMapByTenant = new Map<
        string,
        Map<string, { name: string | null; email: string }>
      >();
      await Promise.all(
        [...userIdsByTenant.entries()].map(async ([tenantId, ids]) => {
          const users = await deps.loader
            .getTenantDataView(tenantId)
            .getUsersByIds([...ids]);
          userMapByTenant.set(
            tenantId,
            new Map(users.map((u) => [u.id, { name: u.name, email: u.email }])),
          );
        }),
      );

      const items: SendHistoryEntry[] = await Promise.all(
        page.map(async (item): Promise<SendHistoryEntry> => {
          const tenantName = await resolveTenantName(item.tenantId);
          const user = userMapByTenant.get(item.tenantId)?.get(item.userId);
          return {
            lane: item.lane,
            tenantId: item.tenantId,
            tenantName,
            userId: item.userId,
            userName: user?.name ?? null,
            userEmail: user?.email ?? null,
            status: item.status,
            processedAt: item.processedAt,
            sentAt: item.sentAt,
            docId: item.docId,
          };
        }),
      );

      const response: GetSendHistoryResponse = {
        items,
        nextCursor: hasMore ? encodeCursor(nextCursorMap) : null,
      };
      res.json(response);
    },
  );

  return router;
}
