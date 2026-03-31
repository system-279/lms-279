/**
 * レッスンセッション（出席管理）ルーター
 * 入室打刻・退室打刻・強制退室・放棄の管理
 */

import { Router, Request, Response } from "express";
import { requireUser } from "../../middleware/auth.js";
import { logger } from "../../utils/logger.js";
import type { LessonSession } from "../../types/entities.js";
import type { LessonSessionResponse } from "@lms-279/shared-types";
import {
  getOrCreateSession,
  forceExitSession,
  abandonSession,
  handleStaleSession,
} from "../../services/lesson-session.js";

const router = Router();

/**
 * セッション作成（入室打刻）
 * POST /lesson-sessions
 */
router.post("/lesson-sessions", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const { lessonId, videoId, sessionToken } = req.body;

  if (!lessonId || typeof lessonId !== "string") {
    res.status(400).json({ error: "invalid_lessonId", message: "lessonId is required" });
    return;
  }
  if (!videoId || typeof videoId !== "string") {
    res.status(400).json({ error: "invalid_videoId", message: "videoId is required" });
    return;
  }
  if (!sessionToken || typeof sessionToken !== "string") {
    res.status(400).json({ error: "invalid_sessionToken", message: "sessionToken is required" });
    return;
  }

  // レッスン存在チェック
  const lesson = await ds.getLessonById(lessonId);
  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "Lesson not found" });
    return;
  }

  try {
    const { session, created } = await getOrCreateSession(
      ds, userId, lessonId, lesson.courseId, videoId, sessionToken
    );

    // 既存セッションが期限切れの場合はハンドル
    if (!created) {
      const handled = await handleStaleSession(ds, session);
      if (handled.status === "force_exited") {
        // 期限切れだったのでトランザクション付きで新規作成
        const { session: newSession } = await getOrCreateSession(
          ds, userId, lessonId, lesson.courseId, videoId, sessionToken
        );
        res.status(201).json({ session: formatSession(newSession) });
        return;
      }
      // 既存のactiveセッションを返す
      res.status(200).json({ session: formatSession(handled) });
      return;
    }

    res.status(201).json({ session: formatSession(session) });
  } catch (err) {
    logger.error("Failed to get-or-create session", {
      error: err instanceof Error ? err : String(err), userId, lessonId,
    });
    res.status(500).json({ error: "session_create_failed", message: "セッション作成に失敗しました。再度お試しください。" });
  }
});

/**
 * アクティブセッション取得（ページリロード復帰用）
 * GET /lesson-sessions/active?lessonId=X
 */
router.get("/lesson-sessions/active", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const lessonId = req.query.lessonId as string;

  if (!lessonId) {
    res.status(400).json({ error: "invalid_lessonId", message: "lessonId query parameter is required" });
    return;
  }

  const session = await ds.getActiveLessonSession(userId, lessonId);
  if (!session) {
    res.status(404).json({ error: "no_active_session", message: "No active session found" });
    return;
  }

  // 期限切れチェック
  const handled = await handleStaleSession(ds, session);
  if (handled.status === "force_exited") {
    res.status(404).json({ error: "session_expired", message: "Session has expired" });
    return;
  }

  res.json({ session: formatSession(handled) });
});

/**
 * 強制退室
 * PATCH /lesson-sessions/:sessionId/force-exit
 */
router.patch("/lesson-sessions/:sessionId/force-exit", requireUser, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const userId = req.user!.id;
  const sessionId = req.params.sessionId as string;
  const { reason } = req.body;

  if (!reason || !["pause_timeout", "time_limit", "browser_close"].includes(reason)) {
    res.status(400).json({ error: "invalid_reason", message: "reason must be pause_timeout, time_limit, or browser_close" });
    return;
  }

  const session = await ds.getLessonSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "not_found", message: "Session not found" });
    return;
  }

  if (session.userId !== userId) {
    res.status(403).json({ error: "forbidden", message: "Not your session" });
    return;
  }

  if (session.status !== "active") {
    res.status(409).json({ error: "session_not_active", message: "Session is not active" });
    return;
  }

  try {
    const exited = await forceExitSession(ds, sessionId, reason);
    res.json({ session: formatSession(exited) });
  } catch (err) {
    logger.error(`Failed to force-exit session ${sessionId}`, { error: String(err) });
    res.status(500).json({ error: "force_exit_failed", message: "セッション終了処理に失敗しました" });
  }
});

/**
 * セッション放棄（ブラウザ終了時sendBeacon用）
 * POST /lesson-sessions/:sessionId/abandon
 *
 * sendBeaconはカスタムヘッダーを送れないためrequireUserを使わず、
 * セッションID（UUID）の知識を暗黙的な認証とする。
 * セッションIDはURL上に露出せず推測困難なUUIDであるため、認証なしでも実用上のリスクは低い。
 * abandoned操作は非破壊的（データリセットなし）かつ冪等性が高いため、
 * 最悪ケースでもセッションが早期終了するだけに留まる。
 */
router.post("/lesson-sessions/:sessionId/abandon", async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const sessionId = req.params.sessionId as string;

  try {
    const session = await ds.getLessonSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "not_found", message: "Session not found" });
      return;
    }

    if (session.status !== "active") {
      res.status(409).json({ error: "session_not_active", message: "Session is not active" });
      return;
    }

    await abandonSession(ds, sessionId);
    res.status(204).end();
  } catch (err) {
    logger.error(`Failed to abandon session ${sessionId}`, { error: String(err) });
    res.status(500).json({ error: "abandon_failed", message: "セッション放棄処理に失敗しました" });
  }
});

function formatSession(session: LessonSession): LessonSessionResponse {
  const remainingMs = Math.max(0, new Date(session.deadlineAt).getTime() - Date.now());
  return {
    id: session.id,
    sessionToken: session.sessionToken,
    status: session.status,
    entryAt: session.entryAt,
    exitAt: session.exitAt,
    exitReason: session.exitReason,
    deadlineAt: session.deadlineAt,
    remainingMs,
    sessionVideoCompleted: session.sessionVideoCompleted,
  };
}

export const lessonSessionsRouter = router;
