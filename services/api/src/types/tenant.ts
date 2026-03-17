/**
 * テナントメタデータの型定義
 */

/**
 * テナントのステータス
 */
export type TenantStatus = "active" | "suspended";

/**
 * テナントメタデータ
 * グローバルな `tenants` コレクションに保存
 */
export interface TenantMetadata {
  /** テナントID（自動生成） */
  id: string;
  /** 組織名 */
  name: string;
  /** オーナーのFirebase UID */
  ownerId: string;
  /** オーナーのメールアドレス */
  ownerEmail: string;
  /** ステータス */
  status: TenantStatus;
  /** 作成日時 */
  createdAt: Date;
  /** 更新日時 */
  updatedAt: Date;
}

/**
 * テナント作成リクエスト
 */
export interface CreateTenantRequest {
  /** 組織名 */
  name: string;
}

/**
 * テナント作成レスポンス
 */
export interface CreateTenantResponse {
  tenant: TenantMetadata;
  /** テナント管理画面のURL */
  adminUrl: string;
  /** 受講者向け画面のURL */
  studentUrl: string;
}
