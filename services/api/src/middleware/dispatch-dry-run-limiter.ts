/**
 * dispatch-dry-run endpoint 専用レート制限ミドルウェア (Phase 4 α-7、AC-α7-12)。
 *
 * 目的:
 *   - super-admin 限定 endpoint だが、誤操作・複数タブ・ブラウザ再試行で
 *     Firestore read 量が増える懸念 (Codex High 指摘)
 *   - IP ベース (globalLimiter) ではなく **super-admin email ベース** で抑制
 *
 * 設計:
 *   - 10 req/min/superAdminEmail
 *   - keyGenerator で req.user.email を取得 (super-admin auth middleware で
 *     セット済前提)。fallback は IP → "anonymous"
 *   - testSendLimiter (PR #490 で撤廃) とは別名・別設計 (過去シンボル復活回避)
 *
 * 関連:
 *   - impl-plan: docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md §3 タスク C1
 *   - AC-α7-12: dry-run endpoint への DoS / 連打防止
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

/**
 * dispatch-dry-run 専用 limiter。
 * `Router.get(path, dispatchDryRunLimiter, handler)` の形で wire する。
 *
 * `req.user` は親 super-admin auth middleware で set される (型は middleware 側で
 * Express namespace 拡張)。本 limiter はその拡張に依存せず、email field を最小限
 * 取り出す duck typing で keyGenerator を実装。
 */
export const dispatchDryRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const user = (req as unknown as { user?: { email?: string | null } }).user;
    const email = user?.email;
    if (email) return `email:${email.toLowerCase()}`;
    // super-admin auth 失敗時の fallback (本来は middleware が先に 403 で弾く想定)。
    // ipKeyGenerator(ip, subnet?) helper で IPv6 prefix を考慮 (ERR_ERL_KEY_GEN_IPV6 回避)
    return `ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many dry-run requests. Please wait a minute and retry.",
    },
  },
});
