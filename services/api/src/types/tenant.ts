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
  /**
   * GCIP Tenant ID（ADR-031 Phase 3）
   * Google Cloud Identity Platform のマルチテナント ID。
   * null の場合は旧 Firebase Auth 経路（非 GCIP）。
   */
  gcipTenantId: string | null;
  /**
   * GCIP 経路を有効化するか（ADR-031 Phase 3、feature flag）
   * true の場合: `decodedToken.firebase.tenant === gcipTenantId` 検証が走る
   * false の場合: 従来の Firebase Auth 経路
   * デフォルトは false（段階的カナリア展開のため）
   */
  useGcip: boolean;
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
