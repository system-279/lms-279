/**
 * 共通ルーターの統合エクスポート
 * DataSourceを使用してデモ/本番両対応
 */

import { Router } from "express";
import { coursesRouter } from "./courses.js";
import { lessonsRouter } from "./lessons.js";
import { usersRouter } from "./users.js";
import { allowedEmailsRouter } from "./allowed-emails.js";
import { authErrorsRouter } from "./auth-errors.js";
import { videosRouter } from "./videos.js";
import { videoEventsRouter } from "./video-events.js";

/**
 * 全ての共通ルーターを統合したルーター
 * テナントコンテキストミドルウェアの後に使用する
 */
export function createSharedRouter(): Router {
  const router = Router();

  // 各機能のルーターをマウント
  router.use(coursesRouter);
  router.use(lessonsRouter);
  router.use(usersRouter);
  router.use(allowedEmailsRouter);
  router.use(authErrorsRouter);
  router.use(videosRouter);
  router.use(videoEventsRouter);

  return router;
}

// 個別ルーターのエクスポート
export { coursesRouter } from "./courses.js";
export { lessonsRouter } from "./lessons.js";
export { usersRouter } from "./users.js";
export { allowedEmailsRouter } from "./allowed-emails.js";
export { authErrorsRouter } from "./auth-errors.js";
export { videosRouter } from "./videos.js";
export { videoEventsRouter } from "./video-events.js";
