/**
 * Platform-scope DataSource singleton (Issue #292).
 *
 * super-admin ミドルウェアはテナント非依存で認証拒否ログを記録する必要があるが、
 * tenantMiddleware が走る前に実行されるため `req.dataSource` が存在しない。
 * このヘルパでプロセス単位の DataSource を singleton 提供し、
 * `createPlatformAuthErrorLog` 経由で root コレクション `platform_auth_error_logs` に書き込む。
 *
 * - `AUTH_MODE=firebase` → `FirestoreDataSource`
 *   （`FirestoreDataSource` の tenantId は `tenants/{tenantId}/` path 解決にのみ使われる。
 *   `createPlatformAuthErrorLog` は root コレクションに書き込むため tenant path を利用せず、
 *   ここに渡す `PLATFORM_TENANT_ID` は書き込みルーティングに影響しない識別子。
 *   なお super-admin.ts 側では `AuthErrorLog.tenantId` フィールドにも同じ識別子を明示的に格納する）
 * - それ以外（dev/test）→ `InMemoryDataSource`
 * - テストから `setPlatformDataSourceForTest()` で差し替え可能
 */
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../datasource/firestore.js";
import { InMemoryDataSource } from "../datasource/in-memory.js";
import type { DataSource } from "../datasource/interface.js";

/**
 * Platform スコープ識別子。`AuthErrorLog.tenantId` フィールドの sentinel 値として使用する。
 * Cloud Logging / BigQuery 上で「platform レベル vs tenant レベル」の拒否を分離する際のキー。
 */
export const PLATFORM_TENANT_ID = "__platform__" as const;

let cached: DataSource | null = null;

export function getPlatformDataSource(): DataSource {
  if (cached) return cached;
  const mode = process.env.AUTH_MODE ?? "dev";
  cached =
    mode === "firebase"
      ? new FirestoreDataSource(getFirestore(), PLATFORM_TENANT_ID)
      : new InMemoryDataSource({ readOnly: false });
  return cached;
}

/** テスト用: platform DataSource をモックに差し替える（null でリセット） */
export function setPlatformDataSourceForTest(ds: DataSource | null): void {
  cached = ds;
}
