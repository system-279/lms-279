/**
 * DataSource ファクトリ
 * テナントコンテキストに応じたDataSourceを生成
 */

import { Firestore } from "@google-cloud/firestore";
import type { DataSource, TenantContext } from "./interface.js";
import { InMemoryDataSource } from "./in-memory.js";
import { FirestoreDataSource } from "./firestore.js";

export type { TenantContext } from "./interface.js";

// Firestoreインスタンスのキャッシュ
let firestoreInstance: Firestore | null = null;

function getFirestore(): Firestore {
  if (!firestoreInstance) {
    const projectId =
      process.env.FIRESTORE_PROJECT_ID ||
      process.env.GCLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT;

    firestoreInstance = new Firestore(
      projectId
        ? {
            projectId,
          }
        : undefined
    );
  }
  return firestoreInstance;
}

// デモ用DataSourceのシングルトン
const demoDataSource = new InMemoryDataSource({ readOnly: true });

// E2Eテスト用DataSource（E2E_TEST_ENABLED=true時のみ生成）
const E2E_TENANT_ID = "e2e-test";
let e2eDataSource = process.env.E2E_TEST_ENABLED === "true"
  ? new InMemoryDataSource({ readOnly: false })
  : null;

export function resetE2eDataSource(): void {
  if (process.env.E2E_TEST_ENABLED === "true") {
    e2eDataSource = new InMemoryDataSource({ readOnly: false });
  }
}

/**
 * テナントコンテキストに応じたDataSourceを取得
 * @throws Error tenantIdが未指定の場合（デモモード以外）
 */
export function getDataSource(context: TenantContext): DataSource {
  if (context.tenantId === E2E_TENANT_ID && e2eDataSource) {
    return e2eDataSource;
  }

  if (context.isDemo) {
    return demoDataSource;
  }

  // 本番用: tenantIdのバリデーション
  if (!context.tenantId) {
    throw new Error("tenantId is required for non-demo DataSource");
  }

  // 本番用: FirestoreDataSource（テナントID付き）
  return new FirestoreDataSource(getFirestore(), context.tenantId);
}
