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
