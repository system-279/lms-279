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
import { getDataSource } from "../../datasource/factory.js";
import { buildProgressPdfData } from "../../services/progress-pdf.js";
import {
  runProgressReportDryRun,
  createStructuredProgressDryRunLogger,
  type ProgressDryRunLogger,
  type ProgressDryRunSampleBuilder,
} from "../../services/dispatch/dry-run/progress-report-dry-run.js";
import { runCompletionNotificationDryRun } from "../../services/dispatch/dry-run/completion-notification-dry-run.js";
import {
  sharedDispatchDryRunSingleFlight,
  type DispatchDryRunSingleFlight,
} from "../../services/dispatch/dry-run/single-flight.js";
import type { DispatchStorage } from "../../services/dispatch/dispatch-storage.js";
import type { TenantDataLoader } from "../../services/dispatch/tenant-data-loader.js";
import { logger as defaultLogger } from "../../utils/logger.js";

/**
 * Phase 4 α-7 code-review F9 反映: `storage` を read-only API のみに narrow し、
 * 将来 route 層で writer メソッドが直接呼ばれる事故を型レベルで防ぐ。
 * service 側 (`Pick<DispatchStorage, "getDispatchSettings">` 等) と整合し、
 * AC-α7-06 (read-only 保証の型レベル担保) を route 層まで貫徹する。
 */
export type DispatchDryRunStorage = Pick<
  DispatchStorage,
  "getDispatchSettings" | "getCompletionNotification"
>;

export interface DispatchDryRunRouteDeps {
  storage: DispatchDryRunStorage;
  loader: TenantDataLoader;
  /** 完了通知 dry-run の MIME From アドレス (環境変数から index.ts で読み取り inject) */
  senderEmail: string;
  /**
   * test では独立 single-flight instance を inject 可能。
   * production / 通常は省略して module スコープ singleton を使用。
   *
   * Phase 4 α-7 code-review F7 (documented behavior): single-flight は同 lane の
   * concurrent waiter に同一 Promise を共有させる。先発 caller の transient error
   * (例: Firestore DEADLINE_EXCEEDED) は後発 caller にもそのまま伝播し、
   * `evaluatedAt` も先発時刻に固定される。これは Firestore read 重複を抑制する
   * 設計上の fail-fast 挙動であり、cross-caller 識別が必要なケースでは limiter
   * (email 単位) の方が先に弾く前提。
   */
  singleFlight?: DispatchDryRunSingleFlight;
  /**
   * test では noop or 独立 limiter instance を inject 可能 (module スコープ
   * `dispatchDryRunLimiter` は process スコープ state を持ち test 間で残るため)。
   * production / 通常は省略して default `dispatchDryRunLimiter` を使用。
   *
   * Phase 4 α-7 code-review F5 (documented behavior): default `dispatchDryRunLimiter`
   * は単一 instance を progress / completion 両 handler に貼っているため、
   * 10 req/min/superAdminEmail は **両 lane 合算** の budget となる
   * (impl-plan §3 C1 文言通り、per-lane granularity は採用しない)。
   * 将来 per-lane に切り替える場合は `limiter` を lane 別に inject する形へ拡張。
   */
  limiter?: RequestHandler;
  /**
   * Phase 4 α-7 code-review F4 反映: tenant_doc_not_found を含む WARN を Cloud Logging
   * に出力させるための構造化 logger 注入点。default は `utils/logger.ts` の構造化
   * logger を adapter 経由で使用 (silent-fail-paired-signal 違反を回避)。
   * test では noop 注入で標準出力汚染を避ける。
   */
  progressDryRunLogger?: ProgressDryRunLogger;
  /**
   * PR2b: 進捗レポート dry-run のテナント代表サンプル文面プレビュー生成器。
   *
   * **意図的に必須 (optional にしない)**: 省略時に「production では実 Firestore を叩く
   * 実装、test では未注入」という暗黙 default を許すと、test fixture がたまたま
   * `wouldSendCount > 0` を作った瞬間に test が無自覚に実 Firestore/DataSource へ
   * アクセスしてしまう事故リスクがある (`senderEmail` が必須なのと同じ理由)。
   * production wiring は本ファイルが export する `productionProgressSampleBuilder`
   * を明示的に渡し、test は stub を明示的に渡すこと。
   */
  progressSampleBuilder: ProgressDryRunSampleBuilder;
}

/** production 実装: `getDataSource` + `buildProgressPdfData` (PDF 実体は生成しない) */
export const productionProgressSampleBuilder: ProgressDryRunSampleBuilder = {
  async buildPdfData({ tenantId, tenantName, ownerEmail, userId, now }) {
    const dataSource = getDataSource({ tenantId, isDemo: false });
    return buildProgressPdfData({
      dataSource,
      tenant: { id: tenantId, name: tenantName, ownerEmail },
      userId,
      now,
    });
  },
};

export function createDispatchDryRunRouter(
  deps: DispatchDryRunRouteDeps,
): Router {
  const router = Router();
  const sf = deps.singleFlight ?? sharedDispatchDryRunSingleFlight;
  const limiter = deps.limiter ?? dispatchDryRunLimiter;
  const progressLogger =
    deps.progressDryRunLogger ?? createStructuredProgressDryRunLogger(defaultLogger);
  const progressSampleBuilder = deps.progressSampleBuilder;

  router.get(
    "/dispatch/dry-run/progress",
    limiter,
    async (_req: Request, res: Response): Promise<void> => {
      const result: DispatchDryRunResult = await sf.run("progress", () =>
        runProgressReportDryRun({
          storage: deps.storage,
          loader: deps.loader,
          now: new Date(),
          logger: progressLogger,
          sampleBuilder: progressSampleBuilder,
          senderEmail: deps.senderEmail,
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
