/**
 * スーパー管理者向け テスト送信ルート (Phase 5)。
 *
 * POST /api/v2/super/dispatch/test-send
 *   200: { messageId, sentTo, sentAt }
 *
 * AC-9: スーパー管理者自身宛に固定ダミーデータ + 添付なしで送信、1 日 50 件レート制限。
 * To は req.superAdmin.email を強制 (任意宛先送信を許さない)。CC なし。
 * 認可は親 (index.ts) で superAdminAuthMiddleware 適用済 (AC-31)。
 *
 * 送信処理 (gmail-dwd-send.sendCompletionMail) は注入 (テスト時 mock)。
 * rateLimiter も注入式 (production は middleware/rate-limiter の testSendLimiter)。
 */

import { Router, type Request, type RequestHandler, type Response } from "express";
import type { TestSendResponse } from "@lms-279/shared-types";
import type { DispatchEnv } from "../../services/dispatch/run-completion-notifications.js";
import {
  isTransientGmailError,
  type SendCompletionMailInput,
  type SendCompletionMailResult,
} from "../../services/dispatch/gmail-dwd-send.js";

/** テスト送信の固定ダミー件名 (PII を含まない) */
export const TEST_SEND_SUBJECT = "【DXcollege】テスト送信";
/** テスト送信の固定ダミー本文 (PII を含まない) */
export const TEST_SEND_BODY =
  "これは DXcollege 自動完了通知システムのテスト送信です。\n" +
  "本メールはスーパー管理者の設定確認用に送信されており、受講者には届きません。\n" +
  "---\nDXcollege運営スタッフ";

export interface DispatchTestSendRouteDeps {
  env: DispatchEnv;
  /** Gmail 送信関数 (production は defaultSendCompletionMail、テストは mock) */
  sendMail: (
    input: SendCompletionMailInput,
  ) => Promise<SendCompletionMailResult>;
  /** sentAt 用 now provider (テスト時固定可) */
  now?: () => Date;
  /** レート制限 middleware (production は testSendLimiter、未指定なら無効) */
  rateLimiter?: RequestHandler;
}

export function createDispatchTestSendRouter(
  deps: DispatchTestSendRouteDeps,
): Router {
  const router = Router();
  const now = deps.now ?? ((): Date => new Date());

  const handler = async (req: Request, res: Response): Promise<void> => {
    const to = req.superAdmin?.email;
    if (!to) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "スーパー管理者として認証されていません。" });
      return;
    }

    try {
      const result = await deps.sendMail({
        subjectEmail: deps.env.subjectEmail,
        fromEmail: deps.env.fromEmail,
        to,
        cc: [],
        subject: TEST_SEND_SUBJECT,
        body: TEST_SEND_BODY,
      });
      const response: TestSendResponse = {
        messageId: result.messageId,
        sentTo: to,
        sentAt: now().toISOString(),
      };
      res.json(response);
    } catch (err) {
      if (isTransientGmailError(err)) {
        res.status(503).json({
          error: "gmail_api_transient",
          message: "Gmail API が一時的に応答しません。時間をおいて再試行してください。",
        });
        return;
      }
      res.status(502).json({
        error: "gmail_api_error",
        message: "Gmail API 送信に失敗しました。",
      });
    }
  };

  const middlewares: RequestHandler[] = [];
  if (deps.rateLimiter) middlewares.push(deps.rateLimiter);
  router.post("/dispatch/test-send", ...middlewares, handler);

  return router;
}
