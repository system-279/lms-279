/**
 * テスト用Expressアプリ作成ヘルパー
 * デモモード相当: InMemoryDataSource + 固定ユーザー
 */

import express from "express";
import cors from "cors";
import { InMemoryDataSource } from "../../datasource/in-memory.js";
import { createSharedRouter } from "../../routes/shared/index.js";

/**
 * 管理者ユーザーでのテスト用Expressアプリを作成
 */
export function createTestApp(options?: { readOnly?: boolean }) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const ds = new InMemoryDataSource({ readOnly: options?.readOnly ?? false });

  // テナントコンテキストとDataSourceを手動注入
  app.use((req, _res, next) => {
    req.tenantContext = { tenantId: "test-tenant", isDemo: false };
    req.dataSource = ds;
    // テスト用デフォルトユーザー（admin）
    req.user = { id: "test-user-1", email: "admin@test.com", role: "admin" };
    next();
  });

  app.use(createSharedRouter());

  return { app, ds };
}

/**
 * 受講者ユーザーでのテスト用Expressアプリを作成
 */
export function createStudentTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const ds = new InMemoryDataSource({ readOnly: false });

  app.use((req, _res, next) => {
    req.tenantContext = { tenantId: "test-tenant", isDemo: false };
    req.dataSource = ds;
    req.user = { id: "test-student-1", email: "student@test.com", role: "student" };
    next();
  });

  app.use(createSharedRouter());

  return { app, ds };
}
