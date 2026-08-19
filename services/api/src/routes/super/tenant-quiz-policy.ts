/**
 * スーパー管理者向け テナント別 テスト任意化設定ルート (Stage 2)。
 *
 * GET  /api/v2/super/tenants/:tenantId/quiz-policy  設定取得（未設定は既定値 200）
 * PUT  /api/v2/super/tenants/:tenantId/quiz-policy   設定更新（2 フィールドとも必須）
 *
 * 認可は親 (super-admin.ts) で superAdminAuthMiddleware を適用済み。
 * Firestore I/O は getDataSource() を再利用（Store 抽象を新設しない設計判断、
 * 実装計画 imperative-bubbling-dijkstra.md 設計判断2）。テナント存在確認と
 * DataSource 取得を deps として注入可能にし、テストでは in-memory fake を使う
 * （tenant-notification-cc.ts の DI パターンを踏襲）。
 */

import { Router, type Request, type Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import type { TenantQuizPolicyResponse, PutTenantQuizPolicyRequest } from "@lms-279/shared-types";
import { getDataSource as getProductionDataSource } from "../../datasource/factory.js";
import type { TenantQuizPolicy } from "../../types/entities.js";
import { validateTenantId } from "../../middleware/tenant.js";
import { resolveTenantQuizPolicy } from "../../services/quiz-policy.js";
import { logger } from "../../utils/logger.js";
import { classifyFirestoreError, TRANSIENT_RETRY_MESSAGE_JA } from "../../utils/grpc-errors.js";

/** テナントスコープの quiz policy 読み書きに必要な最小限の DataSource 部分集合 */
export interface TenantQuizPolicyDataSource {
  getTenantQuizPolicy(): Promise<TenantQuizPolicy | null>;
  upsertTenantQuizPolicy(data: Omit<TenantQuizPolicy, "id" | "updatedAt">): Promise<TenantQuizPolicy>;
}

export interface TenantQuizPolicyRouteDeps {
  /** テナントが実在するか確認する */
  tenantExists: (tenantId: string) => Promise<boolean>;
  /** テナントスコープの DataSource を取得する */
  getDataSource: (tenantId: string) => TenantQuizPolicyDataSource;
}

export function createTenantQuizPolicyRouter(deps: TenantQuizPolicyRouteDeps): Router {
  const router = Router();

  router.get(
    "/tenants/:tenantId/quiz-policy",
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = validateTenantId(req.params.tenantId);
      if (!tenantId) {
        res.status(404).json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
        return;
      }
      const operatorEmail = req.superAdmin!.email;

      try {
        if (!(await deps.tenantExists(tenantId))) {
          res.status(404).json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
          return;
        }

        const dataSource = deps.getDataSource(tenantId);
        const policy = await dataSource.getTenantQuizPolicy();
        const response: TenantQuizPolicyResponse = resolveTenantQuizPolicy(policy);
        res.json(response);
      } catch (e) {
        const { grpcCode, isTransient } = classifyFirestoreError(e);
        logger.error("Tenant quiz policy GET failed", {
          errorType: "tenant_quiz_policy_get_failed",
          error: e instanceof Error ? e : new Error(String(e)),
          tenantId,
          operatorEmail,
          grpcCode,
          isTransient,
        });
        res.status(isTransient ? 503 : 500).json({
          error: "transaction_failed",
          message: isTransient ? TRANSIENT_RETRY_MESSAGE_JA : "テスト任意化設定の取得中にエラーが発生しました。",
        });
      }
    },
  );

  router.put(
    "/tenants/:tenantId/quiz-policy",
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = validateTenantId(req.params.tenantId);
      if (!tenantId) {
        res.status(404).json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
        return;
      }
      const operatorEmail = req.superAdmin!.email;

      const body = (req.body ?? {}) as Partial<PutTenantQuizPolicyRequest>;
      if (typeof body.quizSkipEnabled !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "quizSkipEnabled は boolean が必要です。" });
        return;
      }
      if (typeof body.pdfDownloadAllowedForSkipped !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "pdfDownloadAllowedForSkipped は boolean が必要です。" });
        return;
      }

      try {
        if (!(await deps.tenantExists(tenantId))) {
          res.status(404).json({ error: "tenant_not_found", message: "テナントが見つかりません。" });
          return;
        }

        const dataSource = deps.getDataSource(tenantId);
        const updated = await dataSource.upsertTenantQuizPolicy({
          quizSkipEnabled: body.quizSkipEnabled,
          pdfDownloadAllowedForSkipped: body.pdfDownloadAllowedForSkipped,
          updatedBy: operatorEmail,
        });

        logger.info("Tenant quiz policy upserted by super admin", {
          tenantId,
          operatorEmail,
          quizSkipEnabled: updated.quizSkipEnabled,
          pdfDownloadAllowedForSkipped: updated.pdfDownloadAllowedForSkipped,
        });

        const response: TenantQuizPolicyResponse = resolveTenantQuizPolicy(updated);
        res.json(response);
      } catch (e) {
        const { grpcCode, isTransient } = classifyFirestoreError(e);
        logger.error("Tenant quiz policy PUT failed", {
          errorType: "tenant_quiz_policy_put_failed",
          error: e instanceof Error ? e : new Error(String(e)),
          tenantId,
          operatorEmail,
          grpcCode,
          isTransient,
        });
        res.status(isTransient ? 503 : 500).json({
          error: "transaction_failed",
          message: isTransient ? TRANSIENT_RETRY_MESSAGE_JA : "テスト任意化設定の更新中にエラーが発生しました。",
        });
      }
    },
  );

  return router;
}

/** production wiring: Firebase Admin でテナント存在確認、getDataSource() で書き込み */
export const tenantQuizPolicyRouter = createTenantQuizPolicyRouter({
  tenantExists: async (tenantId) => {
    const doc = await getFirestore().collection("tenants").doc(tenantId).get();
    return doc.exists;
  },
  getDataSource: (tenantId) => getProductionDataSource({ tenantId, isDemo: false }),
});
