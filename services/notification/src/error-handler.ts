/**
 * グローバルエラーハンドラー + 404ハンドラー。
 *
 * services/api/src/middleware/error-handler.ts と同じ「ADR-010 フラット形式
 * { error, message } を返す + logger.error で構造化ログを出す」という方針だが、
 * 本サービスは ADR-010 のネスト形式ではなく `oidc-verify.ts` が既に使っている
 * フラット形式 `{ error: code, message }` に統一する。
 *
 * これが無いと、ハンドラ内の未捕捉例外（Firestore の複合index未デプロイによる
 * FAILED_PRECONDITION 等）が Express 5 の既定エラーハンドラに落ち、(a) HTML 500 に
 * なり呼び出し元(Cloud Scheduler/Pub-Sub push)向けの一貫した形式が崩れる、
 * (b) 構造化ログではなく finalhandler の素の stderr 出力になり、
 * docs/runbook/monitoring-setup.md のログベースメトリクスで検知できない
 * （pr-review-toolkit code-reviewer 指摘、Important）。
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { logger } from "./logger.js";

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  logger.error("notification: 未捕捉のエラーが発生しました", {
    path: req.path,
    method: req.method,
    error: err instanceof Error ? err : new Error(String(err)),
  });
  res.status(500).json({
    error: "internal_error",
    message: "Internal server error",
  });
};

export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    error: "not_found",
    message: `Route ${req.method} ${req.path} not found`,
  });
};
