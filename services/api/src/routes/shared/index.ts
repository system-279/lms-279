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
import { quizzesRouter } from "./quizzes.js";
import { quizAttemptsRouter } from "./quiz-attempts.js";
import { progressRouter } from "./progress.js";
import { analyticsRouter } from "./analytics.js";
import { googleDriveImportRouter } from "./google-drive-import.js";
import { quizGenerationRouter } from "./quiz-generation.js";
import { lessonSessionsRouter } from "./lesson-sessions.js";

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
  router.use(quizzesRouter);
  router.use(quizAttemptsRouter);
  router.use(progressRouter);
  router.use(analyticsRouter);
  router.use(googleDriveImportRouter);
  router.use(quizGenerationRouter);
  router.use(lessonSessionsRouter);

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
export { quizzesRouter } from "./quizzes.js";
export { quizAttemptsRouter } from "./quiz-attempts.js";
export { progressRouter } from "./progress.js";
export { analyticsRouter } from "./analytics.js";
export { googleDriveImportRouter } from "./google-drive-import.js";
export { quizGenerationRouter } from "./quiz-generation.js";
export { lessonSessionsRouter } from "./lesson-sessions.js";
