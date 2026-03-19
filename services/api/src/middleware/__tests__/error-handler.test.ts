/**
 * エラーハンドラミドルウェアのテスト
 *
 * errorHandler: Cloud Error Reporting形式の構造化ログ出力
 * notFoundHandler: 404統一レスポンス
 */

import { describe, it, expect, vi } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import supertest from "supertest";
import { errorHandler, notFoundHandler } from "../error-handler.js";
import { AppError } from "../../utils/errors.js";

function createApp() {
  const app = express();

  // エラーを発生させるルート（next(err)でエラーハンドラに明示的に渡す）
  app.get("/throw-app-error", (_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError("VALIDATION_ERROR", "Invalid input", 422));
  });

  app.get("/throw-error", (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error("Something broke"));
  });

  app.get("/throw-unknown", (_req: Request, _res: Response, next: NextFunction) => {
    next("string error" as unknown);
  });

  // notFoundHandlerとerrorHandlerを登録
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

describe("notFoundHandler", () => {
  it("存在しないルートで404と統一形式エラーを返す", async () => {
    const app = createApp();
    const request = supertest(app);

    const res = await request.get("/nonexistent-route");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toContain("/nonexistent-route");
  });
});

describe("errorHandler", () => {
  it("AppErrorはstatusCodeとtoJSON()形式で返す", async () => {
    const app = createApp();
    const request = supertest(app);

    const res = await request.get("/throw-app-error");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("通常のErrorは500とINTERNAL_ERRORを返す", async () => {
    // loggerのerror出力を抑制
    vi.spyOn(console, "error").mockImplementation(() => {});

    const app = createApp();
    const request = supertest(app);

    const res = await request.get("/throw-error");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.body.error.message).toBe("Internal server error");

    vi.restoreAllMocks();
  });

  it("未知のエラーも500とINTERNAL_ERRORを返す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const app = createApp();
    const request = supertest(app);

    const res = await request.get("/throw-unknown");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");

    vi.restoreAllMocks();
  });
});
