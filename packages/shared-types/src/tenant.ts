/**
 * スーパー管理者向けテナント管理のレスポンス型
 */

export type TenantStatus = "active" | "suspended";

export interface SuperTenantListItem {
  id: string;
  name: string;
  ownerEmail: string;
  status: TenantStatus;
  userCount: number;
  /**
   * GCIP Tenant ID（ADR-031 Phase 3）
   * null の場合は旧 Firebase Auth 経路。
   */
  gcipTenantId: string | null;
  /**
   * GCIP 経路を有効化するか（ADR-031 Phase 3、feature flag）
   * テナント単位のカナリア展開用。
   */
  useGcip: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SuperTenantListResponse {
  tenants: SuperTenantListItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface SuperTenantCreateResponse {
  tenant: SuperTenantListItem;
}

export interface SuperTenantDetailResponse {
  tenant: SuperTenantListItem & {
    ownerId: string;
  };
  stats: {
    userCount: number;
    courseCount: number;
    lessonCount: number;
  };
}

/**
 * 認証不要の公開テナント情報（ADR-031）
 *
 * `GET /api/v2/public/tenants/:tenantId` のレスポンスボディ。
 * FE が GCIP 経路のログイン前に `auth.tenantId` へ `gcipTenantId` をセットするために使用する。
 *
 * 認証不要エンドポイントのため、テナントの識別情報（`name`）・所有者 PII
 * （`ownerId` / `ownerEmail`）・利用規模（`userCount`）・運用時刻
 * （`createdAt` / `updatedAt`）は**意図的に含めない**。新フィールド追加時は
 * 同じ threat model で可否を判断する。
 *
 * `status` は `"active"` / `"suspended"` のいずれか。サーバー側でデータ破損時に
 * `"suspended"` へフェイルクローズする（詳細 ADR-031）。FE は `"active"` 以外を
 * 全てメンテナンス扱いにしてよい。
 */
export interface PublicTenantInfo {
  id: string;
  status: TenantStatus;
  gcipTenantId: string | null;
  useGcip: boolean;
}

export interface PublicTenantInfoResponse {
  tenant: PublicTenantInfo;
}
