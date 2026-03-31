/**
 * スーパー管理者用API
 * 全テナントの管理操作を提供
 *
 * エンドポイント:
 * - GET /api/v2/super/tenants - 全テナント一覧（ページング対応）
 * - GET /api/v2/super/tenants/:id - テナント詳細（統計情報含む）
 * - PATCH /api/v2/super/tenants/:id - テナント更新（name, ownerEmail, status）
 * - DELETE /api/v2/super/tenants/:id - テナント削除（サブコレクション含む完全削除）
 */

import { Router, Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import type { SuperAttendanceResponse } from "@lms-279/shared-types";
import {
  superAdminAuthMiddleware,
  getAllSuperAdmins,
  addSuperAdmin,
  removeSuperAdmin,
} from "../middleware/super-admin.js";
import type { TenantMetadata, TenantStatus } from "../types/tenant.js";
import { masterRouter } from "./super-admin-master.js";

const router = Router();

// 有効なステータス値
const VALID_STATUSES: TenantStatus[] = ["active", "suspended"];

// 全ルートにスーパー管理者認証を適用
router.use(superAdminAuthMiddleware);

// マスターコンテンツ管理ルート
router.use(masterRouter);

/**
 * テナント一覧のレスポンス型
 */
interface TenantListResponse {
  tenants: TenantListItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

interface TenantListItem {
  id: string;
  name: string;
  ownerEmail: string;
  status: TenantStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * テナント詳細のレスポンス型（統計情報含む）
 */
interface TenantDetailResponse {
  tenant: TenantMetadata & {
    createdAt: string | null;
    updatedAt: string | null;
  };
  stats: {
    userCount: number;
    courseCount: number;
    lessonCount: number;
  };
}

/**
 * 全テナント一覧を取得
 * GET /api/v2/super/tenants
 *
 * クエリパラメータ:
 * - status: "active" | "suspended" (optional) - ステータスフィルター
 * - limit: number (default: 50, max: 100) - 取得件数
 * - offset: number (default: 0) - オフセット
 * - sort: "createdAt" | "name" | "updatedAt" (default: "createdAt") - ソートキー
 * - order: "asc" | "desc" (default: "desc") - ソート順
 */
router.get("/tenants", async (req: Request, res: Response) => {
  const db = getFirestore();

  const statusFilter = req.query.status as TenantStatus | undefined;
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 100);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const sortBy = (req.query.sort as string) || "createdAt";
  const sortOrder = (req.query.order as "asc" | "desc") || "desc";

  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    res.status(400).json({
      error: "invalid_status",
      message: "statusは 'active' または 'suspended' を指定してください。",
    });
    return;
  }

  const validSortKeys = ["createdAt", "name", "updatedAt"];
  if (!validSortKeys.includes(sortBy)) {
    res.status(400).json({
      error: "invalid_sort",
      message: "sortは 'createdAt', 'name', 'updatedAt' のいずれかを指定してください。",
    });
    return;
  }

  let query = db.collection("tenants").orderBy(sortBy, sortOrder);

  if (statusFilter) {
    query = db
      .collection("tenants")
      .where("status", "==", statusFilter)
      .orderBy(sortBy, sortOrder);
  }

  const countQuery = statusFilter
    ? db.collection("tenants").where("status", "==", statusFilter)
    : db.collection("tenants");
  const countSnapshot = await countQuery.count().get();
  const total = countSnapshot.data().count;

  const snapshot = await query.offset(offset).limit(limit).get();

  const tenants: TenantListItem[] = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: data.id ?? doc.id,
      name: data.name ?? "",
      ownerEmail: data.ownerEmail ?? "",
      status: data.status ?? "active",
      createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
      updatedAt: data.updatedAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  const response: TenantListResponse = {
    tenants,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + tenants.length < total,
    },
  };

  res.json(response);
});

/**
 * テナント詳細を取得（統計情報含む）
 * GET /api/v2/super/tenants/:id
 */
router.get("/tenants/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const db = getFirestore();

  const tenantDoc = await db.collection("tenants").doc(id).get();
  if (!tenantDoc.exists) {
    res.status(404).json({
      error: "not_found",
      message: "テナントが見つかりません。",
    });
    return;
  }

  const tenantData = tenantDoc.data()!;

  const [userCountSnap, courseCountSnap, lessonCountSnap] = await Promise.all([
    db.collection(`tenants/${id}/users`).count().get(),
    db.collection(`tenants/${id}/courses`).count().get(),
    db.collection(`tenants/${id}/lessons`).count().get(),
  ]);

  const response: TenantDetailResponse = {
    tenant: {
      id: tenantData.id ?? id,
      name: tenantData.name ?? "",
      ownerId: tenantData.ownerId ?? "",
      ownerEmail: tenantData.ownerEmail ?? "",
      status: tenantData.status ?? "active",
      createdAt: tenantData.createdAt?.toDate?.()?.toISOString() ?? null,
      updatedAt: tenantData.updatedAt?.toDate?.()?.toISOString() ?? null,
    },
    stats: {
      userCount: userCountSnap.data().count,
      courseCount: courseCountSnap.data().count,
      lessonCount: lessonCountSnap.data().count,
    },
  };

  res.json(response);
});

/**
 * テナント更新リクエストの型
 */
interface TenantUpdateRequest {
  name?: string;
  ownerEmail?: string;
  status?: TenantStatus;
}

/**
 * テナントを更新
 * PATCH /api/v2/super/tenants/:id
 */
router.patch("/tenants/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name, ownerEmail, status } = req.body as TenantUpdateRequest;

  if (name === undefined && ownerEmail === undefined && status === undefined) {
    res.status(400).json({
      error: "no_fields",
      message: "更新するフィールド（name, ownerEmail, status）を少なくとも1つ指定してください。",
    });
    return;
  }

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({
        error: "invalid_name",
        message: "組織名は空にできません。",
      });
      return;
    }
    if (name.length > 100) {
      res.status(400).json({
        error: "invalid_name",
        message: "組織名は100文字以内で入力してください。",
      });
      return;
    }
  }

  if (ownerEmail !== undefined) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (typeof ownerEmail !== "string" || !emailRegex.test(ownerEmail)) {
      res.status(400).json({
        error: "invalid_email",
        message: "有効なメールアドレス形式で入力してください。",
      });
      return;
    }
  }

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    res.status(400).json({
      error: "invalid_status",
      message: "statusは 'active' または 'suspended' を指定してください。",
    });
    return;
  }

  const db = getFirestore();
  const tenantRef = db.collection("tenants").doc(id);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) {
    res.status(404).json({
      error: "not_found",
      message: "テナントが見つかりません。",
    });
    return;
  }

  const previousData = tenantDoc.data()!;
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  const changes: string[] = [];

  if (name !== undefined && name !== previousData.name) {
    updateData.name = name.trim();
    changes.push(`name: "${previousData.name}" -> "${name.trim()}"`);
  }

  if (ownerEmail !== undefined && ownerEmail !== previousData.ownerEmail) {
    updateData.ownerEmail = ownerEmail.toLowerCase();
    changes.push(`ownerEmail: "${previousData.ownerEmail}" -> "${ownerEmail.toLowerCase()}"`);
  }

  if (status !== undefined && status !== previousData.status) {
    updateData.status = status;
    changes.push(`status: "${previousData.status}" -> "${status}"`);
  }

  if (changes.length === 0) {
    res.status(400).json({
      error: "no_changes",
      message: "変更がありません。",
    });
    return;
  }

  await tenantRef.update(updateData);

  const superAdmin = req.superAdmin;
  console.log(
    `[SuperAdmin] Tenant updated: ${id} - ${changes.join(", ")} by ${superAdmin?.email}`
  );

  const updatedDoc = await tenantRef.get();
  const updatedData = updatedDoc.data()!;

  res.json({
    tenant: {
      id: updatedData.id ?? id,
      name: updatedData.name ?? "",
      ownerId: updatedData.ownerId ?? "",
      ownerEmail: updatedData.ownerEmail ?? "",
      status: updatedData.status ?? "active",
      createdAt: updatedData.createdAt?.toDate?.()?.toISOString() ?? null,
      updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() ?? null,
    },
  });
});

/**
 * テナントを削除（サブコレクション含む完全削除）
 * DELETE /api/v2/super/tenants/:id
 */
router.delete("/tenants/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const db = getFirestore();

  const tenantRef = db.collection("tenants").doc(id);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) {
    res.status(404).json({
      error: "not_found",
      message: "テナントが見つかりません。",
    });
    return;
  }

  const tenantData = tenantDoc.data()!;

  await db.recursiveDelete(tenantRef);

  const superAdmin = req.superAdmin;
  console.log(
    `[SuperAdmin] Tenant deleted: ${id} (${tenantData.name}) by ${superAdmin?.email}`
  );

  res.json({
    message: "テナントを削除しました。",
    deletedTenant: {
      id,
      name: tenantData.name ?? "",
    },
  });
});

// ============================================
// スーパー管理者管理API
// ============================================

/**
 * スーパー管理者一覧を取得
 * GET /api/v2/super/admins
 */
router.get("/admins", async (_req: Request, res: Response) => {
  const admins = await getAllSuperAdmins();
  res.json({ admins });
});

/**
 * スーパー管理者を追加
 * POST /api/v2/super/admins
 */
router.post("/admins", async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== "string") {
    res.status(400).json({
      error: "invalid_email",
      message: "有効なメールアドレスを指定してください。",
    });
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({
      error: "invalid_email",
      message: "有効なメールアドレス形式で指定してください。",
    });
    return;
  }

  const addedBy = req.superAdmin?.email ?? "unknown";
  await addSuperAdmin(email, addedBy);

  res.status(201).json({
    message: "スーパー管理者を追加しました。",
    admin: {
      email: email.toLowerCase(),
      source: "firestore",
      addedBy,
      addedAt: new Date().toISOString(),
    },
  });
});

/**
 * スーパー管理者を削除
 * DELETE /api/v2/super/admins/:email
 */
router.delete("/admins/:email", async (req: Request, res: Response) => {
  const email = decodeURIComponent(req.params.email as string);

  const admins = await getAllSuperAdmins();
  const targetAdmin = admins.find((a) => a.email === email.toLowerCase());

  if (!targetAdmin) {
    res.status(404).json({
      error: "not_found",
      message: "指定されたスーパー管理者が見つかりません。",
    });
    return;
  }

  if (targetAdmin.source === "env") {
    res.status(400).json({
      error: "cannot_delete",
      message: "環境変数で設定されたスーパー管理者は削除できません。",
    });
    return;
  }

  if (req.superAdmin?.email === email.toLowerCase()) {
    res.status(400).json({
      error: "cannot_delete_self",
      message: "自分自身を削除することはできません。",
    });
    return;
  }

  await removeSuperAdmin(email);

  console.log(`[SuperAdmin] Admin removed: ${email} by ${req.superAdmin?.email}`);

  res.json({
    message: "スーパー管理者を削除しました。",
  });
});

// ============================================================
// テナント別出席・テスト結果レポート
// ============================================================

/**
 * GET /tenants/:tenantId/attendance-report
 * テナント内の受講者出席・テスト結果一覧を取得
 */
router.get("/tenants/:tenantId/attendance-report", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;
  const { from, to } = req.query;

  // テナント存在確認
  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }

  const basePath = `tenants/${tenantId}`;

  // セッション一覧取得
  let sessionsQuery = db.collection(`${basePath}/lesson_sessions`)
    .orderBy("entryAt", "desc") as FirebaseFirestore.Query;

  // 日付フィルタ: JST基準（UTC+9）でUTC境界に変換
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const fromStr = typeof from === "string" ? from : undefined;
  const toStr = typeof to === "string" ? to : undefined;
  if (fromStr) {
    // JST日付の開始 = UTC前日15:00
    const fromUtc = new Date(new Date(`${fromStr}T00:00:00`).getTime() - JST_OFFSET_MS).toISOString();
    sessionsQuery = sessionsQuery.where("entryAt", ">=", fromUtc);
  }
  if (toStr) {
    // JST日付の終了 = UTC当日14:59:59.999
    const toUtc = new Date(new Date(`${toStr}T23:59:59.999`).getTime() - JST_OFFSET_MS).toISOString();
    sessionsQuery = sessionsQuery.where("entryAt", "<=", toUtc);
  }

  const sessionsSnapshot = await sessionsQuery.get();

  // ユーザー情報を一括取得
  const usersSnapshot = await db.collection(`${basePath}/users`).get();
  const usersMap = new Map<string, { name: string | null; email: string | null }>();
  for (const doc of usersSnapshot.docs) {
    const data = doc.data();
    usersMap.set(doc.id, { name: data.name ?? null, email: data.email ?? null });
  }

  // テスト受験結果を一括取得（提出済みのみ）
  const attemptsSnapshot = await db.collection(`${basePath}/quiz_attempts`)
    .where("status", "==", "submitted")
    .get();
  const attemptsMap = new Map<string, { score: number | null; isPassed: boolean | null; submittedAt: string | null }>();
  for (const doc of attemptsSnapshot.docs) {
    const data = doc.data();
    attemptsMap.set(doc.id, {
      score: data.score ?? null,
      isPassed: data.isPassed ?? null,
      submittedAt: data.submittedAt?.toDate?.().toISOString?.() ?? data.submittedAt ?? null,
    });
  }

  // レッスン名を取得
  const lessonsSnapshot = await db.collection(`${basePath}/lessons`).get();
  const lessonsMap = new Map<string, string>();
  for (const doc of lessonsSnapshot.docs) {
    lessonsMap.set(doc.id, doc.data().title ?? doc.id);
  }

  // レポート行を構築
  const records = sessionsSnapshot.docs.map((doc) => {
    const data = doc.data();
    const user = usersMap.get(data.userId);
    const attempt = data.quizAttemptId ? attemptsMap.get(data.quizAttemptId) : null;

    return {
      id: doc.id,
      userId: data.userId,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      lessonId: data.lessonId,
      lessonTitle: lessonsMap.get(data.lessonId) ?? data.lessonId,
      date: data.entryAt?.toDate?.().toISOString?.()?.split("T")[0]
        ?? (typeof data.entryAt === "string" ? data.entryAt.split("T")[0] : null),
      entryAt: data.entryAt?.toDate?.().toISOString?.() ?? data.entryAt ?? null,
      exitAt: data.exitAt?.toDate?.().toISOString?.() ?? data.exitAt ?? null,
      exitReason: data.exitReason ?? null,
      status: data.status,
      quizAttemptId: data.quizAttemptId ?? null,
      quizScore: attempt?.score ?? null,
      quizPassed: attempt?.isPassed ?? null,
      quizSubmittedAt: attempt?.submittedAt ?? null,
    };
  });

  const response: SuperAttendanceResponse = {
    tenantId,
    tenantName: tenantDoc.data()?.name ?? tenantId,
    records,
    totalRecords: records.length,
  };
  res.json(response);
});

/**
 * PATCH /tenants/:tenantId/attendance-report/:sessionId
 * 出席レコードの手動編集（入退室打刻・テスト結果の補正）
 */
router.patch("/tenants/:tenantId/attendance-report/:sessionId", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;
  const sessionId = req.params.sessionId as string;
  const { entryAt, exitAt, quizScore, quizPassed } = req.body;

  // 入力バリデーション
  const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  if (entryAt !== undefined && (typeof entryAt !== "string" || !ISO_DATE_REGEX.test(entryAt) || isNaN(Date.parse(entryAt)))) {
    res.status(400).json({ error: "invalid_entryAt", message: "entryAt must be a valid ISO 8601 UTC datetime" });
    return;
  }
  if (exitAt !== undefined && (typeof exitAt !== "string" || !ISO_DATE_REGEX.test(exitAt) || isNaN(Date.parse(exitAt)))) {
    res.status(400).json({ error: "invalid_exitAt", message: "exitAt must be a valid ISO 8601 UTC datetime" });
    return;
  }
  if (entryAt !== undefined && exitAt !== undefined && new Date(entryAt) > new Date(exitAt)) {
    res.status(400).json({ error: "invalid_time_range", message: "entryAt must be before exitAt" });
    return;
  }
  if (quizScore !== undefined && (typeof quizScore !== "number" || !Number.isFinite(quizScore) || quizScore < 0 || quizScore > 100)) {
    res.status(400).json({ error: "invalid_quizScore", message: "quizScore must be a number between 0 and 100" });
    return;
  }
  if (quizPassed !== undefined && typeof quizPassed !== "boolean") {
    res.status(400).json({ error: "invalid_quizPassed", message: "quizPassed must be a boolean" });
    return;
  }

  const basePath = `tenants/${tenantId}`;
  const sessionRef = db.collection(`${basePath}/lesson_sessions`).doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Session not found" });
    return;
  }

  // セッション更新
  const sessionUpdate: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (entryAt !== undefined) sessionUpdate.entryAt = entryAt;
  if (exitAt !== undefined) sessionUpdate.exitAt = exitAt;
  await sessionRef.update(sessionUpdate);

  // テスト結果更新（quizAttemptIdがある場合）
  const quizAttemptId = sessionDoc.data()?.quizAttemptId;
  if (quizAttemptId && (quizScore !== undefined || quizPassed !== undefined)) {
    const attemptRef = db.collection(`${basePath}/quiz_attempts`).doc(quizAttemptId);
    const attemptUpdate: Record<string, unknown> = {};
    if (quizScore !== undefined) attemptUpdate.score = quizScore;
    if (quizPassed !== undefined) attemptUpdate.isPassed = quizPassed;
    await attemptRef.update(attemptUpdate);
  }

  res.json({ message: "updated" });
});

export const superAdminRouter = router;
