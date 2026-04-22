/**
 * Platform-scope DataSource singleton (Issue #292).
 *
 * super-admin ミドルウェアはテナント非依存で認証拒否ログを記録する必要があるが、
 * tenantMiddleware が走る前に実行されるため `req.dataSource` が存在しない。
 * このヘルパでプロセス単位の DataSource を singleton 提供し、
 * `createPlatformAuthErrorLog` 経由で root コレクション `platform_auth_error_logs` に書き込む。
 *
 * - `AUTH_MODE=firebase` → `FirestoreDataSource`（tenantId="__platform__" は未使用のため任意値）
 * - それ以外（dev/test）→ `InMemoryDataSource`
 * - テストから `setPlatformDataSourceForTest()` で差し替え可能
 */
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreDataSource } from "../datasource/firestore.js";
import { InMemoryDataSource } from "../datasource/in-memory.js";
import type { DataSource } from "../datasource/interface.js";

let cached: DataSource | null = null;

export function getPlatformDataSource(): DataSource {
  if (cached) return cached;
  const mode = process.env.AUTH_MODE ?? "dev";
  cached =
    mode === "firebase"
      ? new FirestoreDataSource(getFirestore(), "__platform__")
      : new InMemoryDataSource({ readOnly: false });
  return cached;
}

/** テスト用: platform DataSource をモックに差し替える（null でリセット） */
export function setPlatformDataSourceForTest(ds: DataSource | null): void {
  cached = ds;
}
