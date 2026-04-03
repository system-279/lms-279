/**
 * アクセス許可メール関連の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const { email, note } = req.body;

  if (!email || !EMAIL_REGEX.test(email)) {
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
 * 管理者向け: 許可メール削除
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
  res.status(204).send();
});

export const allowedEmailsRouter = router;
