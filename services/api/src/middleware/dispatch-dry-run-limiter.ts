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
 *   - keyGenerator で req.superAdmin.email を取得 (super-admin auth middleware で
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
 * `req.superAdmin` は親 `superAdminAuthMiddleware` で `{ email, firebaseUid? }`
 * として set される (services/api/src/middleware/super-admin.ts:376 / :485)。
 * 本 limiter はその拡張に依存せず、email field を最小限取り出す duck typing で
 * keyGenerator を実装。Codex review (2026-06-04) で `req.user` 読みは middleware
 * と shape 不一致のため IP fallback に collapse する誤りが指摘され修正済。
 */
export const dispatchDryRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const superAdmin = (
      req as unknown as { superAdmin?: { email?: string | null } }
    ).superAdmin;
    const email = superAdmin?.email;
    if (email) return `email:${email.toLowerCase()}`;
    // super-admin auth 失敗時の fallback (本来は middleware が先に 403 で弾く想定)。
    // Phase 4 α-7 code-review F6 反映: `req.ip ?? ""` を `ipKeyGenerator` に渡すと
    // 空文字解釈で全 anonymous request が固定 key に collapse し self-DoS の温床に
    // なる。fallback を fixed sentinel に切り替え、本来到達しないコード経路で
    // 偶発的 collapse が起きないようにする。
    const ip = req.ip;
    return ip ? `ip:${ipKeyGenerator(ip)}` : "ip:anonymous-no-ip";
  },
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many dry-run requests. Please wait a minute and retry.",
    },
  },
});
