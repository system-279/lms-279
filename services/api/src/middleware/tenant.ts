/**
 * テナントコンテキストミドルウェア
 * URLパスからテナントIDを抽出し、適切なDataSourceを設定
 */

import { Request, Response, NextFunction } from "express";
import { getDataSource, type TenantContext, type DataSource, ReadOnlyDataSourceError } from "../datasource/index.js";

// Express Request を拡張
declare global {
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
      dataSource?: DataSource;
    }
  }
}

// デモテナントID
const DEMO_TENANT_ID = "demo";

// テナントID検証用正規表現（英数字、ハイフン、アンダースコアのみ）
const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const TENANT_ID_MAX_LENGTH = 64;
const TENANT_ID_MIN_LENGTH = 1;

/**
 * テナントIDの検証
 */
function validateTenantId(tenantId: unknown): string | null {
  // 配列の場合は最初の要素を使用（Express 5対応）
  const normalizedId = Array.isArray(tenantId) ? tenantId[0] : tenantId;

  if (typeof normalizedId !== "string") {
    return null;
  }

  if (normalizedId.length < TENANT_ID_MIN_LENGTH || normalizedId.length > TENANT_ID_MAX_LENGTH) {
    return null;
  }

  if (!TENANT_ID_REGEX.test(normalizedId)) {
    return null;
  }

  return normalizedId;
}

/**
 * テナントコンテキストミドルウェア
 * パスパラメータ :tenant からテナントIDを抽出
 */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rawTenantId = req.params.tenant;

  // テナントIDの検証
  const tenantId = validateTenantId(rawTenantId);
  if (!tenantId) {
    res.status(400).json({
      error: "invalid_tenant_id",
      message: "Invalid tenant ID. Must be 1-64 alphanumeric characters, hyphens, or underscores.",
    });
    return;
  }

  const isDemo = tenantId === DEMO_TENANT_ID;

  const tenantContext: TenantContext = {
    tenantId,
    isDemo,
  };

  req.tenantContext = tenantContext;
  req.dataSource = getDataSource(tenantContext);

  next();
}

/**
 * デモ認証ミドルウェア
 * デモテナントの場合、固定のデモユーザーを設定
 */
export function demoAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (req.tenantContext?.isDemo) {
    req.user = {
      id: "demo-admin",
      role: "admin",
      email: "admin@demo.example.com",
    };
  }
  next();
}

/**
 * デモモード読み取り専用ミドルウェア
 * POST/PATCH/DELETE/PUT をブロック
 */
export function demoReadOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantContext?.isDemo) {
    next();
    return;
  }

  const readOnlyMethods = ["POST", "PATCH", "DELETE", "PUT"];
  if (readOnlyMethods.includes(req.method)) {
    res.status(403).json({
      error: "demo_read_only",
      message: "デモモードでは変更操作はできません",
    });
    return;
  }

  next();
}

/**
 * DataSource読み取り専用エラーハンドラ
 */
export function dataSourceErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof ReadOnlyDataSourceError) {
    res.status(403).json({
      error: "read_only",
      message: "This data source is read-only",
    });
    return;
  }
  next(err);
}
