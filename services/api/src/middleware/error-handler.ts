/**
 * グローバルエラーハンドラーミドルウェア
 *
 * ADR-0025: エラーレスポンス形式の統一
 */

import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { AppError, ErrorCode } from "../utils/errors.js";

/**
 * グローバルエラーハンドラー
 * 全てのエラーをキャッチして統一形式でレスポンスを返す
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // AppErrorの場合はそのまま使用
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // 通常のErrorの場合は500エラーに変換
  if (err instanceof Error) {
    console.error("Unhandled error:", err);
    res.status(500).json({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "Internal server error",
      },
    });
    return;
  }

  // その他の場合も500エラー
  console.error("Unknown error:", err);
  res.status(500).json({
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
    },
  });
};

/**
 * 404 Not Found ハンドラー
 * 存在しないルートへのリクエストをハンドル
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
};
