/**
 * レート制限ミドルウェア
 *
 * ADR-025: セキュリティ強化
 */

import rateLimit from "express-rate-limit";

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
