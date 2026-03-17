/**
 * ユーザー関連の共通ルーター
 * DataSourceを使用してデモ/本番両対応
 */

import { Router, Request, Response } from "express";
import { requireUser, requireAdmin } from "../../middleware/auth.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ["admin", "teacher", "student"] as const;

const router = Router();

/**
 * 認証ユーザー情報取得
 * GET /auth/me
 */
router.get("/auth/me", requireUser, async (req: Request, res: Response) => {
  const tenantId = req.tenantContext?.tenantId;
  let tenantName: string | undefined;

  if (tenantId && !req.tenantContext?.isDemo) {
    try {
      const { getFirestore } = await import("firebase-admin/firestore");
      const doc = await getFirestore().collection("tenants").doc(tenantId).get();
      tenantName = doc.exists ? (doc.data()?.name as string) : undefined;
    } catch {
      // ignore - tenant name is optional
    }
  }

  res.json({
    user: req.user,
    ...(tenantName && { tenantName }),
  });
});

/**
 * 管理者向け: ユーザー一覧取得
 * GET /admin/users
 */
router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const users = await ds.getUsers();

  res.json({
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    })),
  });
});

/**
 * 管理者向け: ユーザー作成
 * POST /admin/users
 */
router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const { email, name, role } = req.body;

  if (!email || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: "invalid_email", message: "Valid email is required" });
    return;
  }

  if (role && !(VALID_ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: "invalid_role", message: "Role must be admin, teacher, or student" });
    return;
  }

  const existing = await ds.getUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: "email_exists", message: "User with this email already exists" });
    return;
  }

  const user = await ds.createUser({
    email,
    name: name ?? null,
    role: role ?? "student",
  });

  // ユーザー作成時にallowed_emailsにも自動追加（ログインできるようにするため）
  const isAllowed = await ds.isEmailAllowed(email);
  if (!isAllowed) {
    await ds.createAllowedEmail({ email, note: null });
  }

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: ユーザー詳細取得
 * GET /admin/users/:id
 */
router.get("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const user = await ds.getUserById(id);
  if (!user) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: ユーザー更新
 * PATCH /admin/users/:id
 */
router.patch("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;
  const { name, role } = req.body;

  const existing = await ds.getUserById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  if (role && !(VALID_ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: "invalid_role", message: "Role must be admin, teacher, or student" });
    return;
  }

  const user = await ds.updateUser(id, {
    ...(name !== undefined && { name }),
    ...(role !== undefined && { role }),
  });

  res.json({
    user: {
      id: user!.id,
      email: user!.email,
      name: user!.name,
      role: user!.role,
      createdAt: user!.createdAt.toISOString(),
      updatedAt: user!.updatedAt.toISOString(),
    },
  });
});

/**
 * 管理者向け: ユーザー削除
 * DELETE /admin/users/:id
 */
router.delete("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const existing = await ds.getUserById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  await ds.deleteUser(id);
  res.status(204).send();
});

/**
 * 管理者向け: ユーザー設定取得
 * GET /admin/users/:id/settings
 */
router.get("/admin/users/:id/settings", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;

  const user = await ds.getUserById(id);
  if (!user) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  const settings = await ds.getUserSettings(id);

  res.json({
    settings: settings ?? {
      userId: id,
      notificationEnabled: true,
      timezone: "Asia/Tokyo",
      updatedAt: null,
    },
  });
});

/**
 * 管理者向け: ユーザー設定更新
 * PATCH /admin/users/:id/settings
 */
router.patch("/admin/users/:id/settings", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const id = req.params.id as string;
  const { notificationEnabled, timezone } = req.body;

  const user = await ds.getUserById(id);
  if (!user) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  const settings = await ds.upsertUserSettings(id, {
    ...(notificationEnabled !== undefined && { notificationEnabled }),
    ...(timezone !== undefined && { timezone }),
  });

  res.json({ settings });
});

export const usersRouter = router;
