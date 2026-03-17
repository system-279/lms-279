/**
 * リクエストログミドルウェア
 *
 * リクエスト/レスポンスをJSON形式でログ出力
 */

import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

// Express RequestにrequestIdを追加
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * リクエストIDを生成
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `req-${timestamp}${random}`;
}

/**
 * リクエストログミドルウェア
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();

  // リクエストIDを設定（既存のものがあれば使用）
  req.requestId =
    (req.headers["x-request-id"] as string) || generateRequestId();

  // リクエストコンテキストを収集
  const context: Record<string, unknown> = {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
  };

  // テナントIDがあれば追加
  if ((req as Request & { tenantId?: string }).tenantId) {
    context.tenantId = (req as Request & { tenantId?: string }).tenantId;
  }

  // ユーザーIDがあれば追加
  if ((req as Request & { user?: { id: string } }).user?.id) {
    context.userId = (req as Request & { user?: { id: string } }).user!.id;
  }

  // リクエスト開始ログ
  logger.info("Request started", context);

  // レスポンス完了時のログ
  res.on("finish", () => {
    const durationMs = Date.now() - startTime;

    logger.info("Request completed", {
      ...context,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}
