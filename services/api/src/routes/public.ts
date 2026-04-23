/**
 * 認証不要の公開 API（ADR-031: GCIP マルチテナント対応）
 *
 * `GET /api/v2/public/tenants/:tenantId`
 *   FE が GCIP 経路のログイン前に `auth.tenantId` へ GCIP Tenant ID を
 *   セットするために使用する。認証不要のためレスポンスフィールドは最小化し、
 *   存在チェックと予約語チェックは同一レスポンスで返す（enumeration 防止）。
 */

import { Router, Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import type { PublicTenantInfo, PublicTenantInfoResponse } from "@lms-279/shared-types";
import type { TenantMetadata, TenantStatus } from "../types/tenant.js";
import { RESERVED_TENANT_IDS, parseTenantGcipFields } from "../utils/tenant-id.js";
import { logger } from "../utils/logger.js";

const router = Router();

/** tenantId の許容形式: 小文字英数字・アンダースコア・ハイフン、1〜64 文字 */
const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const ALLOWED_STATUSES = new Set<TenantStatus>(["active", "suspended"]);

/** 認証不要 endpoint の HTTP キャッシュ方針
 *
 * 200 と 404 は同一の `Cache-Control` を返し、header から存在有無が推測
 * できないようにする。503 は `no-store` で障害回復後に古い応答を再提示しない。
 * `stale-while-revalidate` は付与しない（super-admin の suspend 操作が
 * 最大 SWR 期間分遅延するのを避けるため）。
 */
const CACHE_CONTROL_DEFAULT = "public, max-age=60";
const CACHE_CONTROL_UNAVAILABLE = "no-store";

/**
 * 公開レスポンス用テナント情報の構築。
 *
 * ここを単一の audit point として、`TenantMetadata` から外に出してよい
 * フィールドだけを明示的に pick する。新しい `TenantMetadata` フィールドが
 * 追加されても、この関数を通過しない限り公開 response には含まれない。
 * `status` は fail-closed: 想定外の値はすべて `"suspended"` に正規化する。
 */
function toPublicTenantInfo(
  tenantId: string,
  data: Partial<TenantMetadata>
): PublicTenantInfo {
  const rawStatus = data.status;
  let status: TenantStatus;
  if (typeof rawStatus === "string" && ALLOWED_STATUSES.has(rawStatus)) {
    status = rawStatus;
  } else {
    logger.warn("Tenant status has invalid value; falling back to suspended", {
      errorType: "tenant_status_invalid",
      tenantId,
      actualValue: typeof rawStatus === "string" ? rawStatus : typeof rawStatus,
    });
    status = "suspended";
  }

  return {
    id: tenantId,
    status,
    ...parseTenantGcipFields({ ...data, id: tenantId }),
  };
}

function sendNotFound(res: Response): void {
  res.set("Cache-Control", CACHE_CONTROL_DEFAULT);
  res.status(404).json({
    error: "tenant_not_found",
    message: "Tenant not found",
  });
}

router.get("/tenants/:tenantId", async (req: Request, res: Response) => {
  const rawTenantId = req.params.tenantId;
  const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;

  if (
    typeof tenantId !== "string" ||
    !TENANT_ID_PATTERN.test(tenantId) ||
    RESERVED_TENANT_IDS.has(tenantId)
  ) {
    sendNotFound(res);
    return;
  }

  const db = getFirestore();

  let snapshot;
  try {
    snapshot = await db.collection("tenants").doc(tenantId).get();
  } catch (err) {
    // 5xx は運用上のインシデント（IAM regression / quota / 一時障害 等）に
    // 相当するため error 重大度で記録し、SDK の構造化エラー情報を保持する。
    const firestoreErrorCode =
      err && typeof err === "object" && "code" in err
        ? ((err as { code?: unknown }).code ?? null)
        : null;
    logger.error("Public tenant lookup failed (Firestore error)", {
      errorType: "public_tenant_firestore_error",
      tenantId,
      firestoreErrorCode,
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // 障害回復後に古い 503 が CDN/ブラウザで再提示されないよう明示的にキャッシュ無効化
    res.set("Cache-Control", CACHE_CONTROL_UNAVAILABLE);
    res.status(503).json({
      error: "firestore_unavailable",
      message: "Tenant directory is temporarily unavailable. Please retry.",
    });
    return;
  }

  if (!snapshot.exists) {
    sendNotFound(res);
    return;
  }

  const data = snapshot.data() as Partial<TenantMetadata> | undefined;
  if (!data) {
    sendNotFound(res);
    return;
  }

  const tenant = toPublicTenantInfo(tenantId, data);

  res.set("Cache-Control", CACHE_CONTROL_DEFAULT);
  const response: PublicTenantInfoResponse = { tenant };
  res.status(200).json(response);
});

export { router as publicRouter };
