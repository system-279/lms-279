/**
 * レート制限ミドルウェア
 *
 * ADR-025: セキュリティ強化
 */

import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";

/**
 * グローバルレート制限: 100リクエスト/分/IP
 */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
  },
});

/**
 * 認証系レート制限: 10リクエスト/分/IP（ブルートフォース防止）
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
  },
});

/**
 * 配信テスト送信レート制限: 50 件/日/スーパー管理者 (AC-9、DXcollege Phase 5)。
 *
 * キーはスーパー管理者 email (IP ではなく利用者単位)。エラーは ADR-010 フラット形式で
 * `rate_limit_exceeded` を返す (TestSendErrorCode と整合)。
 * 注: in-memory store のため複数 Cloud Run インスタンス間では共有されない (1 インスタンス
 * あたり 50/日)。本機能は低頻度なため許容 (将来分散したい場合は外部 store を検討)。
 */
export const testSendLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: DISPATCH_CONSTRAINTS.TEST_SEND_DAILY_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request): string =>
    req.superAdmin?.email ?? req.ip ?? "unknown",
  message: {
    error: "rate_limit_exceeded",
    message: "テスト送信の 1 日あたり上限に達しました。",
  },
});
