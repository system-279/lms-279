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
