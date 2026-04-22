/**
 * テナントID生成ユーティリティ
 * tenants.ts と super-admin.ts の両方から使用
 */

import type { DocumentData } from "firebase-admin/firestore";
import { logger } from "./logger.js";

/**
 * 予約済みテナントID（ルートと競合するID）
 */
export const RESERVED_TENANT_IDS = new Set([
  "demo",
  "admin",
  "student",
  "api",
  "tenants",
  "register",
  "login",
  "logout",
  "auth",
  "healthz",
  "static",
  "public",
  "_next",
  "favicon",
  "robots",
  "sitemap",
  "_master",
  "super",
  "help",
]);

/**
 * テナントID生成（8文字のランダム英数字）
 * 予約済みIDとの衝突を回避する
 */
export function generateTenantId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let result = "";
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!RESERVED_TENANT_IDS.has(result)) return result;
  }
  throw new Error("Failed to generate non-reserved tenant ID");
}

/**
 * 組織名のバリデーション
 * @returns trimされた組織名、無効な場合はnull
 */
export function validateOrganizationName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return null;
  return trimmed;
}

/**
 * メールアドレスの正規化
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Firestore tenant ドキュメントから GCIP フィールド（`gcipTenantId` / `useGcip`）を
 * 安全に読み取る。既存ドキュメントに欠落している場合は非 GCIP の default（`null` / `false`）を返す。
 *
 * ADR-031 Phase 3: スキーマに 2 フィールドが追加されたが、既存テナントは backfill 前。
 * 読み取り箇所（GET 一覧 / GET 詳細 / PATCH previous / PATCH response）で default 値読み取りが
 * 4 箇所に重複していたため抽出。
 *
 * 型不整合（Firestore 手動編集や旧バージョンからの backfill ミス等で数値や boolean string が
 * 混入したケース）は default に fallback するが、silent に通過させると Phase 3 の認証経路の
 * 原因調査が困難になるため `logger.warn` で観測可能にする（`rules/error-handling.md §2`）。
 */
export function parseTenantGcipFields(
  data: DocumentData
): { gcipTenantId: string | null; useGcip: boolean } {
  const rawGcipTenantId = data.gcipTenantId;
  const rawUseGcip = data.useGcip;

  if (
    rawGcipTenantId !== undefined &&
    rawGcipTenantId !== null &&
    typeof rawGcipTenantId !== "string"
  ) {
    logger.warn("Tenant gcipTenantId has invalid type; falling back to null", {
      errorType: "tenant_gcip_field_type_mismatch",
      field: "gcipTenantId",
      actualType: typeof rawGcipTenantId,
      tenantId: typeof data.id === "string" ? data.id : null,
    });
  }
  if (rawUseGcip !== undefined && typeof rawUseGcip !== "boolean") {
    logger.warn("Tenant useGcip has invalid type; falling back to false", {
      errorType: "tenant_gcip_field_type_mismatch",
      field: "useGcip",
      actualType: typeof rawUseGcip,
      tenantId: typeof data.id === "string" ? data.id : null,
    });
  }

  return {
    gcipTenantId: typeof rawGcipTenantId === "string" ? rawGcipTenantId : null,
    useGcip: rawUseGcip === true,
  };
}
