/**
 * 認証不要の公開 API（ADR-031: GCIP マルチテナント対応の一部）
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
 * 公開情報のみで機密は含まれないため、ブラウザ / CDN での短期キャッシュを許可し
 * Firestore read と hot-path レイテンシを抑制する。値が変わるのは super-admin の
 * 操作時のみのため、60 秒の max-age と 300 秒の SWR で UX 影響なし。
 */
const CACHE_CONTROL_FOUND = "public, max-age=60, stale-while-revalidate=300";
const CACHE_CONTROL_NOT_FOUND = "public, max-age=30";

function sendNotFound(res: Response): void {
  res.set("Cache-Control", CACHE_CONTROL_NOT_FOUND);
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
    logger.warn("Public tenant lookup failed (Firestore error)", {
      tenantId,
      error: String(err),
    });
    // 障害回復後に古い 503 が CDN/ブラウザで再提示されないよう明示的にキャッシュ無効化
    res.set("Cache-Control", "no-store");
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

  // status は fail-closed で判定する。`active` への silent fallback は
  // データ破損時に suspended テナントが active として漏洩するリスクがあるため、
  // 想定外の値はすべて suspended 扱いでメンテ状態を返す。
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

  let name: string;
  if (typeof data.name === "string") {
    name = data.name;
  } else {
    logger.warn("Tenant name has invalid value; falling back to empty string", {
      errorType: "tenant_name_invalid",
      tenantId,
      actualType: typeof data.name,
    });
    name = "";
  }

  const tenant: PublicTenantInfo = {
    id: tenantId,
    name,
    status,
    ...parseTenantGcipFields({ ...data, id: tenantId }),
  };

  res.set("Cache-Control", CACHE_CONTROL_FOUND);
  const response: PublicTenantInfoResponse = { tenant };
  res.status(200).json(response);
});

export { router as publicRouter };
