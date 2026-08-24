import type { Firestore } from "firebase-admin/firestore";
import { logger } from "./logger.js";

/**
 * テナント自己一致ガード（Phase 2b PR C1）。
 *
 * super adminは services/api 側ではテナント横断アクセスを許可されるが
 * （tenant-auth.ts の buildAuthUser がallowlistチェックをバイパスする）、
 * MCP経由の書き込み解禁でこれが「チャット経由で他テナントのquizを作成・更新・
 * 削除できる」リスクに格上げされたため、MCP層は独立に
 * tenants/{tenant}/allowed_emails を再チェックする。services/api の
 * isEmailAllowed（firestore.ts）と全く同じクエリパターン。
 *
 * 継続的認可境界（ADR-006/031）としての性質上、結果はキャッシュしない。
 */

export type TenantMembershipResult = "member" | "denied";

export interface TenantMembershipChecker {
  checkMembership(tenant: string, email: string): Promise<TenantMembershipResult>;
}

export function createTenantMembershipChecker(db: Firestore): TenantMembershipChecker {
  return {
    async checkMembership(tenant: string, email: string): Promise<TenantMembershipResult> {
      const normalized = email.trim().toLowerCase();
      try {
        const snapshot = await db
          .collection(`tenants/${tenant}/allowed_emails`)
          .where("email", "==", normalized)
          .limit(1)
          .get();
        return snapshot.empty ? "denied" : "member";
      } catch (error) {
        // Firestoreクエリ自体の失敗（障害・権限エラー等）はfail-openで通してはならない
        // （Codexセカンドオピニオン指摘）。判定不能は「所属していない」として扱う。
        logger.error("Tenant membership check failed; failing closed", {
          tenant,
          error: String(error),
        });
        return "denied";
      }
    },
  };
}
