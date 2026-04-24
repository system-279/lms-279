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

/**
 * `GET /api/v2/tenants/mine` のレスポンス要素
 *
 * 「ログインユーザーがアクセス可能なテナント」の最小情報を返す。
 * - owner として作成したテナント
 * - allowed_emails に email が登録されたテナント（招待）
 * の和集合（重複排除済み）。
 *
 * `ownerEmail` は意図的に含めない。招待ユーザーに対しても等しく返却される
 * エンドポイントのため、招待された全テナントの所有者 email が漏れる。
 * owner 自身が必要な場合は別エンドポイント（super-admin 系）から取得する。
 *
 * 既知制約:
 *   - 本一覧は「実際のテナントアクセス可能性」と完全一致しない場合がある。
 *     GCIP UID 揺り戻し（uid_reassignment_blocked）により、一覧に出ても
 *     `/{tenantId}` 直アクセス時に 403 となる偽陽性が起こり得る。
 *   - 同一 email が複数テナントの allowed_emails に登録されている場合、
 *     その principal は登録された全テナントの id / name / status を取得可能。
 *     これは ADR-006「email を境界にする allowlist」の設計上の副作用。
 *
 * `accessVia` 等の入手経路情報は含めない（緊急修正のため契約変更を最小化）。
 * 将来 UI で owner/invited を区別したくなった場合は、別フィールドとして
 * 後方互換を保ったまま追加すること（owner 優先 1 値潰しは情報を失うので不可）。
 */
export interface MyTenantInfo {
  id: string;
  name: string;
  status: TenantStatus;
  createdAt: string | null;
}

export interface MineTenantsResponse {
  tenants: MyTenantInfo[];
}
