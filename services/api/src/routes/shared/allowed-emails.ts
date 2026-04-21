/**
 * アクセス許可メール関連の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { revokeRefreshTokensByEmail } from "../../services/auth-revoke.js";
import { logger } from "../../utils/logger.js";
import { normalizeEmail } from "../../utils/tenant-id.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = normalizeEmail(raw);
  if (normalized.length === 0 || !EMAIL_REGEX.test(normalized)) return null;
  return normalized;
}

const router = Router();

/**
 * 管理者向け: 許可メール一覧取得
 * GET /admin/allowed-emails
 */
router.get("/admin/allowed-emails", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const emails = await ds.getAllowedEmails();

  res.json({
    allowedEmails: emails.map((e) => ({
      id: e.id,
      email: e.email,
      note: e.note,
      createdAt: e.createdAt,
    })),
  });
});

/**
 * 管理者向け: 許可メール追加
 * POST /admin/allowed-emails
 */
router.post("/admin/allowed-emails", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const { email: rawEmail, note } = req.body;
  const email = parseEmailInput(rawEmail);

  if (!email) {
    res.status(400).json({ error: "invalid_email", message: "Valid email is required" });
    return;
  }

  const isAllowed = await ds.isEmailAllowed(email);
  if (isAllowed) {
    res.status(409).json({ error: "email_exists", message: "Email is already in the allowed list" });
    return;
  }

  const allowedEmail = await ds.createAllowedEmail({
    email,
    note: note ?? null,
  });

  res.status(201).json({
    allowedEmail: {
      id: allowedEmail.id,
      email: allowedEmail.email,
      note: allowedEmail.note,
      createdAt: allowedEmail.createdAt,
    },
  });
});

/**
 * 管理者向け: 許可メール削除 + Firebase Auth セッション即時失効（ベストエフォート）
 * DELETE /admin/allowed-emails/:id
 */
router.delete("/admin/allowed-emails/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const existing = await ds.getAllowedEmailById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "Allowed email not found" });
    return;
  }

  await ds.deleteAllowedEmail(id);

  try {
    await revokeRefreshTokensByEmail(existing.email);
  } catch (error) {
    logger.warn("Failed to revoke refresh tokens after allowed-email deletion", {
      email: existing.email,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  res.status(204).send();
});

export const allowedEmailsRouter = router;
