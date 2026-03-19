/**
 * マスターコンテンツAPI テスト用Expressアプリ作成ヘルパー
 *
 * 前提: 呼び出し側で vi.mock によるモックが適用済みであること
 *   - ../../datasource/firestore.js
 *   - firebase-admin/firestore
 *   - ../../services/course-distributor.js
 */

import express from "express";
import { masterRouter } from "../../routes/super-admin-master.js";

/**
 * マスターコンテンツAPI用テストアプリを作成
 * masterRouter をマウントし、superAdmin 認証をバイパスする
 */
export function createSuperAdminApp() {
  const app = express();
  app.use(express.json());

  // superAdmin を手動注入（認証バイパス）
  app.use((req, _res, next) => {
    req.superAdmin = { email: "super@test.com" };
    next();
  });

  app.use(masterRouter);

  return app;
}
