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
  const { name, role } = req.body;
  const email = typeof req.body.email === "string" ? req.body.email.toLowerCase().trim() : req.body.email;

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

/**
 * 管理者向け: CSV一括ユーザーインポート
 * POST /admin/users/import
 *
 * Body: { csv: string } — CSV文字列（ヘッダー行あり、email必須、name/role任意）
 * 上限: 500行、1MB
 */
router.post("/admin/users/import", requireAdmin, async (req: Request, res: Response) => {
  const ds = req.dataSource!;
  const { csv } = req.body;

  if (!csv || typeof csv !== "string") {
    res.status(400).json({ error: "invalid_request", message: "csv field is required" });
    return;
  }

  if (csv.length > 1_000_000) {
    res.status(400).json({ error: "too_large", message: "CSV must be under 1MB" });
    return;
  }

  // BOM除去
  const cleanCsv = csv.replace(/^\uFEFF/, "");
  const lines = cleanCsv.split(/\r?\n/).filter((line) => line.trim());

  if (lines.length < 2) {
    res.status(400).json({ error: "invalid_csv", message: "CSV must have a header row and at least one data row" });
    return;
  }

  if (lines.length > 501) {
    res.status(400).json({ error: "too_many_rows", message: "CSV must have 500 rows or fewer (excluding header)" });
    return;
  }

  // ヘッダー解析
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf("email");
  if (emailIdx === -1) {
    res.status(400).json({ error: "missing_header", message: "CSV must have an 'email' column" });
    return;
  }
  const nameIdx = headers.indexOf("name");
  const roleIdx = headers.indexOf("role");

  const results: {
    created: { email: string; name: string | null; role: string }[];
    skipped: { email: string; reason: string }[];
    errors: { line: number; email?: string; reason: string }[];
  } = { created: [], skipped: [], errors: [] };

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const email = cols[emailIdx]?.toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
      results.errors.push({ line: i + 1, email: email || undefined, reason: "invalid_email" });
      continue;
    }

    const name = nameIdx !== -1 ? cols[nameIdx] || null : null;
    const role = roleIdx !== -1 ? cols[roleIdx]?.toLowerCase() || "student" : "student";

    if (!(VALID_ROLES as readonly string[]).includes(role)) {
      results.errors.push({ line: i + 1, email, reason: `invalid_role: ${role}` });
      continue;
    }

    // 重複チェック
    const existing = await ds.getUserByEmail(email);
    if (existing) {
      results.skipped.push({ email, reason: "already_exists" });
      continue;
    }

    try {
      const user = await ds.createUser({
        email,
        name,
        role: role as "admin" | "teacher" | "student",
      });

      // allowed_emailsにも自動追加
      const isAllowed = await ds.isEmailAllowed(email);
      if (!isAllowed) {
        await ds.createAllowedEmail({ email, note: "CSV import" });
      }

      results.created.push({ email: user.email!, name: user.name, role: user.role });
    } catch {
      results.errors.push({ line: i + 1, email, reason: "creation_failed" });
    }
  }

  res.status(200).json({
    summary: {
      total: lines.length - 1,
      created: results.created.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
    },
    ...results,
  });
});

export const usersRouter = router;
