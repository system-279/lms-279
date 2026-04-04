/**
 * スーパー管理者用API
 * 全テナントの管理操作を提供
 *
 * エンドポイント:
 * - GET /api/v2/super/tenants - 全テナント一覧（ページング対応）
 * - POST /api/v2/super/tenants - テナント作成（name, ownerEmail）
 * - GET /api/v2/super/tenants/:id - テナント詳細（統計情報含む）
 * - PATCH /api/v2/super/tenants/:id - テナント更新（name, ownerEmail, status）
 * - DELETE /api/v2/super/tenants/:id - テナント削除（サブコレクション含む完全削除）
 */

import { Router, Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import type { SuperAttendanceResponse, SuperStudentProgressResponse, TenantEnrollmentSettingResponse } from "@lms-279/shared-types";
import {
  superAdminAuthMiddleware,
  getAllSuperAdmins,
  addSuperAdmin,
  removeSuperAdmin,
} from "../middleware/super-admin.js";
import type { TenantMetadata, TenantStatus } from "../types/tenant.js";
import { masterRouter } from "./super-admin-master.js";
import { calculateDefaultDeadlines } from "../services/enrollment.js";
import { generateTenantId, normalizeEmail } from "../utils/tenant-id.js";
import { logger } from "../utils/logger.js";

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
  userCount: number;
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

  // 各テナントのユーザー数を並列取得
  const userCounts = await Promise.all(
    snapshot.docs.map((doc) =>
      db.collection(`tenants/${doc.id}/users`).count().get()
    )
  );

  const tenants: TenantListItem[] = snapshot.docs.map((doc, i) => {
    const data = doc.data();
    return {
      id: data.id ?? doc.id,
      name: data.name ?? "",
      ownerEmail: data.ownerEmail ?? "",
      status: data.status ?? "active",
      userCount: userCounts[i].data().count,
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
 * テナント作成（スーパー管理者用）
 * POST /api/v2/super/tenants
 *
 * リクエストボディ: { name: string, ownerEmail: string }
 */
router.post("/tenants", async (req: Request, res: Response) => {
  const { name, ownerEmail } = req.body as { name?: string; ownerEmail?: string };

  // バリデーション
  if (!name || typeof name !== "string" || name.trim().length === 0) {
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

  if (!ownerEmail || typeof ownerEmail !== "string") {
    res.status(400).json({
      error: "invalid_email",
      message: "オーナーのメールアドレスを指定してください。",
    });
    return;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(ownerEmail)) {
    res.status(400).json({
      error: "invalid_email",
      message: "有効なメールアドレス形式で入力してください。",
    });
    return;
  }

  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const trimmedName = name.trim();

  const db = getFirestore();

  // ユニークなテナントIDを生成
  let tenantId = "";
  let attempts = 0;
  const maxAttempts = 10;

  try {
    while (attempts < maxAttempts) {
      tenantId = generateTenantId();
      const existingDoc = await db.collection("tenants").doc(tenantId).get();
      if (!existingDoc.exists) break;
      logger.warn("Tenant ID collision during creation", { tenantId, attempt: attempts + 1 });
      attempts++;
    }
  } catch (e) {
    logger.error("Failed to check tenant ID uniqueness", {
      error: e instanceof Error ? e : new Error(String(e)),
      tenantId,
      operatorEmail: req.superAdmin?.email,
    });
    res.status(500).json({
      error: "id_generation_failed",
      message: "テナントIDの生成中にエラーが発生しました。再度お試しください。",
    });
    return;
  }

  if (attempts >= maxAttempts) {
    res.status(500).json({
      error: "id_generation_failed",
      message: "テナントIDの生成に失敗しました。再度お試しください。",
    });
    return;
  }

  const now = new Date();

  // オーナーのFirebase UIDを解決（未登録ユーザーの場合はnull）
  let ownerUid: string | null = null;
  try {
    const userRecord = await getAuth().getUserByEmail(normalizedOwnerEmail);
    ownerUid = userRecord.uid;
  } catch {
    // ユーザーが未登録の場合は初回ログイン時に解決される
  }

  // トランザクションでテナント作成（createで重複を防止）
  try {
    await db.runTransaction(async (transaction) => {
      const tenantRef = db.collection("tenants").doc(tenantId);
      transaction.create(tenantRef, {
        id: tenantId,
        name: trimmedName,
        ownerId: ownerUid ?? "",
        ownerEmail: normalizedOwnerEmail,
        status: "active" as TenantStatus,
        createdAt: now,
        updatedAt: now,
      });

      // 許可リストにオーナーメールを追加
      const allowedEmailRef = db
        .collection("tenants")
        .doc(tenantId)
        .collection("allowed_emails")
        .doc();
      transaction.set(allowedEmailRef, {
        id: allowedEmailRef.id,
        email: normalizedOwnerEmail,
        note: "オーナー（スーパー管理者が登録）",
        createdAt: now,
      });

      // オーナーが既存Firebase Authユーザーの場合、初期管理者ユーザーを作成
      if (ownerUid) {
        const userRef = db
          .collection("tenants")
          .doc(tenantId)
          .collection("users")
          .doc();
        transaction.set(userRef, {
          id: userRef.id,
          email: normalizedOwnerEmail,
          name: null,
          role: "admin",
          firebaseUid: ownerUid,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
  } catch (txError) {
    const grpcCode = (txError as { code?: number })?.code;
    const isTransient = grpcCode === 14 || grpcCode === 4;

    logger.error("Tenant creation transaction failed", {
      error: txError instanceof Error ? txError : new Error(String(txError)),
      tenantId,
      ownerEmail: normalizedOwnerEmail,
      operatorEmail: req.superAdmin?.email,
      grpcCode,
      isTransient,
    });

    res.status(isTransient ? 503 : 500).json({
      error: "transaction_failed",
      message: isTransient
        ? "サーバーが一時的に利用できません。数秒後に再度お試しください。"
        : "テナントの作成中にエラーが発生しました。",
    });
    return;
  }

  logger.info("Tenant created by super admin", {
    tenantId,
    tenantName: trimmedName,
    ownerEmail: normalizedOwnerEmail,
    operatorEmail: req.superAdmin?.email,
  });

  res.status(201).json({
    tenant: {
      id: tenantId,
      name: trimmedName,
      ownerId: ownerUid ?? "",
      ownerEmail: normalizedOwnerEmail,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  });
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
    const normalizedNewEmail = normalizeEmail(ownerEmail);
    updateData.ownerEmail = normalizedNewEmail;
    changes.push(`ownerEmail: "${previousData.ownerEmail}" -> "${normalizedNewEmail}"`);
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

  logger.info("Tenant updated by super admin", {
    tenantId: id,
    changes,
    operatorEmail: req.superAdmin?.email,
  });

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

  try {
    await db.recursiveDelete(tenantRef);
  } catch (deleteError) {
    logger.error("Tenant deletion failed", {
      error: deleteError instanceof Error ? deleteError : new Error(String(deleteError)),
      tenantId: id,
      operatorEmail: req.superAdmin?.email,
    });
    res.status(500).json({
      error: "delete_failed",
      message: "テナントの削除中にエラーが発生しました。再度お試しください。",
    });
    return;
  }

  logger.info("Tenant deleted by super admin", {
    tenantId: id,
    tenantName: tenantData.name,
    operatorEmail: req.superAdmin?.email,
  });

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

  // コース名を取得
  const coursesSnapshot = await db.collection(`${basePath}/courses`).get();
  const coursesMap = new Map<string, string>();
  for (const doc of coursesSnapshot.docs) {
    coursesMap.set(doc.id, doc.data().name ?? doc.id);
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
      courseId: data.courseId ?? "",
      courseName: coursesMap.get(data.courseId) ?? (data.courseId ? `(削除済みコース: ${data.courseId.slice(0, 8)}…)` : ""),
      lessonId: data.lessonId,
      lessonTitle: lessonsMap.get(data.lessonId) ?? (data.lessonId ? `(削除済みレッスン: ${data.lessonId.slice(0, 8)}…)` : data.lessonId),
      date: data.entryAt?.toDate?.().toISOString?.()?.split("T")[0]
        ?? (typeof data.entryAt === "string" ? data.entryAt.split("T")[0] : null),
      entryAt: data.entryAt?.toDate?.().toISOString?.() ?? data.entryAt ?? null,
      exitAt: data.exitAt?.toDate?.().toISOString?.() ?? data.exitAt ?? null,
      exitReason: data.exitReason ?? null,
      status: data.status,
      quizAttemptId: data.quizAttemptId ?? null,
      quizScore: attempt?.score ?? data.quizScore ?? null,
      quizPassed: attempt?.isPassed ?? data.quizPassed ?? null,
      quizSubmittedAt: attempt?.submittedAt ?? null,
    };
  });

  // デフォルトソート: 受講者名 → コース名 → レッスン名
  records.sort((a, b) => {
    const nameComp = (a.userName ?? "").localeCompare(b.userName ?? "", "ja");
    if (nameComp !== 0) return nameComp;
    const courseComp = a.courseName.localeCompare(b.courseName, "ja");
    if (courseComp !== 0) return courseComp;
    return a.lessonTitle.localeCompare(b.lessonTitle, "ja");
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
  const { entryAt, exitAt, exitReason, quizScore, quizPassed } = req.body;

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
  const VALID_EXIT_REASONS = ["quiz_submitted", "pause_timeout", "time_limit", "browser_close", "max_attempts_failed"];
  if (exitReason !== undefined && (typeof exitReason !== "string" || !VALID_EXIT_REASONS.includes(exitReason))) {
    res.status(400).json({ error: "invalid_exitReason", message: `exitReason must be one of: ${VALID_EXIT_REASONS.join(", ")}` });
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
  if (exitReason !== undefined) sessionUpdate.exitReason = exitReason;
  await sessionRef.update(sessionUpdate);

  // テスト結果更新
  if (quizScore !== undefined || quizPassed !== undefined) {
    const quizAttemptId = sessionDoc.data()?.quizAttemptId;
    if (quizAttemptId) {
      // quiz_attemptsドキュメントを更新
      const attemptRef = db.collection(`${basePath}/quiz_attempts`).doc(quizAttemptId);
      const attemptUpdate: Record<string, unknown> = {};
      if (quizScore !== undefined) attemptUpdate.score = quizScore;
      if (quizPassed !== undefined) attemptUpdate.isPassed = quizPassed;
      await attemptRef.update(attemptUpdate);
    }
    // セッションにも直接保存（quizAttemptIdがない場合のフォールバック）
    const quizUpdate: Record<string, unknown> = {};
    if (quizScore !== undefined) quizUpdate.quizScore = quizScore;
    if (quizPassed !== undefined) quizUpdate.quizPassed = quizPassed;
    await sessionRef.update(quizUpdate);
  }

  res.json({ message: "updated" });
});

// ============================================================
// テナント別受講状況管理
// ============================================================

// 進捗データ取得の共通ヘルパー（GET/POST export-sheetsで共用）
type ProgressData = {
  usersSnapshot: FirebaseFirestore.QuerySnapshot;
  coursesSnapshot: FirebaseFirestore.DocumentSnapshot[];
  lessonsMap: Map<string, { title: string; hasVideo: boolean; hasQuiz: boolean }>;
  progressMap: Map<string, { videoCompleted: boolean; quizPassed: boolean; quizBestScore: number | null; lessonCompleted: boolean }>;
  courseProgressMap: Map<string, { completedLessons: number; totalLessons: number; progressRatio: number; isCompleted: boolean }>;
  sessionsMap: Map<string, { sessionId: string; entryAt: string | null; exitAt: string | null; exitReason: string | null }>;
};

async function fetchStudentProgressData(
  db: FirebaseFirestore.Firestore,
  tenantId: string,
  courseIdFilter?: string
): Promise<ProgressData> {
  const basePath = `tenants/${tenantId}`;

  const [usersSnapshot, lessonsSnap, progressSnap, courseProgressSnap, sessionsSnap] = await Promise.all([
    db.collection(`${basePath}/users`).where("role", "==", "student").get(),
    db.collection(`${basePath}/lessons`).get(),
    db.collection(`${basePath}/user_progress`).get(),
    db.collection(`${basePath}/course_progress`).get(),
    db.collection(`${basePath}/lesson_sessions`).orderBy("entryAt", "desc").get(),
  ]);

  let coursesSnapshot: FirebaseFirestore.DocumentSnapshot[];
  if (courseIdFilter) {
    const courseDoc = await db.collection(`${basePath}/courses`).doc(courseIdFilter).get();
    coursesSnapshot = courseDoc.exists ? [courseDoc] : [];
  } else {
    const snap = await db.collection(`${basePath}/courses`).get();
    coursesSnapshot = snap.docs;
  }

  const lessonsMap = new Map<string, { title: string; hasVideo: boolean; hasQuiz: boolean }>();
  for (const doc of lessonsSnap.docs) {
    const data = doc.data();
    lessonsMap.set(doc.id, { title: data.title ?? doc.id, hasVideo: data.hasVideo ?? false, hasQuiz: data.hasQuiz ?? false });
  }

  const progressMap = new Map<string, { videoCompleted: boolean; quizPassed: boolean; quizBestScore: number | null; lessonCompleted: boolean }>();
  for (const doc of progressSnap.docs) {
    const d = doc.data();
    progressMap.set(doc.id, { videoCompleted: d.videoCompleted ?? false, quizPassed: d.quizPassed ?? false, quizBestScore: d.quizBestScore ?? null, lessonCompleted: d.lessonCompleted ?? false });
  }

  const courseProgressMap = new Map<string, { completedLessons: number; totalLessons: number; progressRatio: number; isCompleted: boolean }>();
  for (const doc of courseProgressSnap.docs) {
    const d = doc.data();
    courseProgressMap.set(doc.id, { completedLessons: d.completedLessons ?? 0, totalLessons: d.totalLessons ?? 0, progressRatio: d.progressRatio ?? 0, isCompleted: d.isCompleted ?? false });
  }

  // 最新セッションのみ保持（entryAt descでソート済みなので最初に見つかったものが最新）
  const sessionsMap = new Map<string, { sessionId: string; entryAt: string | null; exitAt: string | null; exitReason: string | null }>();
  for (const doc of sessionsSnap.docs) {
    const d = doc.data();
    const key = `${d.userId}_${d.lessonId}`;
    if (!sessionsMap.has(key)) {
      sessionsMap.set(key, {
        sessionId: doc.id,
        entryAt: d.entryAt?.toDate?.().toISOString?.() ?? d.entryAt ?? null,
        exitAt: d.exitAt?.toDate?.().toISOString?.() ?? d.exitAt ?? null,
        exitReason: d.exitReason ?? null,
      });
    }
  }

  return { usersSnapshot, coursesSnapshot, lessonsMap, progressMap, courseProgressMap, sessionsMap };
}

/**
 * GET /tenants/:tenantId/student-progress
 * テナント内受講生のコース別・レッスン別進捗一覧
 * クエリ: ?courseId=xxx でコース絞り込み可
 */
router.get("/tenants/:tenantId/student-progress", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;
  const courseIdFilter = typeof req.query.courseId === "string" ? req.query.courseId : undefined;

  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }

  const { usersSnapshot, coursesSnapshot, lessonsMap, progressMap, courseProgressMap, sessionsMap } =
    await fetchStudentProgressData(db, tenantId, courseIdFilter);

  const students = usersSnapshot.docs.map((userDoc) => {
    const userData = userDoc.data();
    const userId = userDoc.id;

    const courses = coursesSnapshot.map((courseDoc) => {
      const courseData = courseDoc.data();
      if (!courseData) return null;
      const courseId = courseDoc.id;
      const lessonOrder: string[] = courseData.lessonOrder ?? [];
      const cpKey = `${userId}_${courseId}`;
      const cp = courseProgressMap.get(cpKey);

      const lessons = lessonOrder.map((lessonId) => {
        const lessonInfo = lessonsMap.get(lessonId);
        const upKey = `${userId}_${lessonId}`;
        const up = progressMap.get(upKey);
        const session = sessionsMap.get(upKey);
        return {
          lessonId,
          lessonTitle: lessonInfo?.title ?? lessonId,
          videoCompleted: up?.videoCompleted ?? false,
          quizPassed: up?.quizPassed ?? false,
          quizBestScore: up?.quizBestScore ?? null,
          lessonCompleted: up?.lessonCompleted ?? false,
          latestSessionId: session?.sessionId ?? null,
          latestEntryAt: session?.entryAt ?? null,
          latestExitAt: session?.exitAt ?? null,
          latestExitReason: session?.exitReason ?? null,
        };
      });

      return {
        courseId,
        courseName: courseData.name ?? courseId,
        completedLessons: cp?.completedLessons ?? 0,
        totalLessons: cp?.totalLessons ?? lessonOrder.length,
        progressRatio: cp?.progressRatio ?? 0,
        isCompleted: cp?.isCompleted ?? false,
        lessons,
      };
    }).filter((c): c is NonNullable<typeof c> => c !== null);

    return { userId, userName: userData.name ?? null, userEmail: userData.email ?? "", courses };
  });

  const response: SuperStudentProgressResponse = {
    tenantId,
    tenantName: tenantDoc.data()?.name ?? tenantId,
    students,
    totalStudents: students.length,
  };
  res.json(response);
});

/**
 * PATCH /tenants/:tenantId/student-progress/:lessonId/:userId
 * 受講者のレッスン進捗を手動編集
 */
router.patch("/tenants/:tenantId/student-progress/:lessonId/:userId", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;
  const lessonId = req.params.lessonId as string;
  const userId = req.params.userId as string;
  const { videoCompleted, quizPassed, quizBestScore, lessonCompleted } = req.body;

  // バリデーション
  if (videoCompleted !== undefined && typeof videoCompleted !== "boolean") {
    res.status(400).json({ error: "invalid_videoCompleted", message: "videoCompleted must be a boolean" });
    return;
  }
  if (quizPassed !== undefined && typeof quizPassed !== "boolean") {
    res.status(400).json({ error: "invalid_quizPassed", message: "quizPassed must be a boolean" });
    return;
  }
  if (quizBestScore !== undefined && (typeof quizBestScore !== "number" || !Number.isFinite(quizBestScore) || quizBestScore < 0 || quizBestScore > 100)) {
    res.status(400).json({ error: "invalid_quizBestScore", message: "quizBestScore must be a number between 0 and 100" });
    return;
  }
  if (lessonCompleted !== undefined && typeof lessonCompleted !== "boolean") {
    res.status(400).json({ error: "invalid_lessonCompleted", message: "lessonCompleted must be a boolean" });
    return;
  }

  if (videoCompleted === undefined && quizPassed === undefined && quizBestScore === undefined && lessonCompleted === undefined) {
    res.status(400).json({ error: "no_fields", message: "At least one field must be provided" });
    return;
  }

  const basePath = `tenants/${tenantId}`;

  // テナント存在確認
  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }

  // ユーザー存在確認
  const userDoc = await db.collection(`${basePath}/users`).doc(userId).get();
  if (!userDoc.exists) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  // レッスン存在確認 + courseId取得
  const lessonDoc = await db.collection(`${basePath}/lessons`).doc(lessonId).get();
  if (!lessonDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Lesson not found" });
    return;
  }
  const courseId = lessonDoc.data()?.courseId;
  if (!courseId || typeof courseId !== "string") {
    res.status(422).json({ error: "invalid_lesson_data", message: "Lesson has no valid courseId" });
    return;
  }

  // 事前にレッスン情報・user_progressを一括取得（トランザクション外で読み取り）
  const [allLessonsSnap, userProgressSnap, courseDoc] = await Promise.all([
    db.collection(`${basePath}/lessons`).get(),
    db.collection(`${basePath}/user_progress`)
      .where("userId", "==", userId)
      .where("courseId", "==", courseId)
      .get(),
    db.collection(`${basePath}/courses`).doc(courseId).get(),
  ]);

  // user_progress + course_progressをトランザクションで一括更新
  await db.runTransaction(async (tx) => {
    const progressId = `${userId}_${lessonId}`;
    const progressRef = db.collection(`${basePath}/user_progress`).doc(progressId);
    const currentDoc = await tx.get(progressRef);
    const current = currentDoc.data() ?? {};

    const updatedData: Record<string, unknown> = {
      userId, lessonId, courseId, updatedAt: new Date(),
    };
    if (videoCompleted !== undefined) updatedData.videoCompleted = videoCompleted;
    if (quizPassed !== undefined) updatedData.quizPassed = quizPassed;
    if (quizBestScore !== undefined) updatedData.quizBestScore = quizBestScore;
    if (lessonCompleted !== undefined) updatedData.lessonCompleted = lessonCompleted;

    tx.set(progressRef, { ...current, ...updatedData }, { merge: true });

    // course_progress再計算
    if (courseDoc.exists) {
      const courseData = courseDoc.data()!;
      const lessonOrder: string[] = courseData.lessonOrder ?? [];
      const totalLessons = lessonOrder.length;

      if (totalLessons > 0) {
        const allLessonsMap = new Map<string, { hasVideo: boolean; hasQuiz: boolean }>();
        for (const doc of allLessonsSnap.docs) {
          const d = doc.data();
          allLessonsMap.set(doc.id, { hasVideo: d.hasVideo ?? false, hasQuiz: d.hasQuiz ?? false });
        }

        const userProgressMap = new Map<string, boolean>();
        for (const doc of userProgressSnap.docs) {
          userProgressMap.set(doc.id, doc.data()?.lessonCompleted ?? false);
        }

        let completedLessons = 0;
        for (const lid of lessonOrder) {
          const lesson = allLessonsMap.get(lid);
          if (lesson && !lesson.hasVideo && !lesson.hasQuiz) {
            completedLessons++;
            continue;
          }
          const upId = `${userId}_${lid}`;
          let isLessonCompleted: boolean;
          if (lid === lessonId) {
            isLessonCompleted = (lessonCompleted !== undefined ? lessonCompleted : current.lessonCompleted) ?? false;
          } else {
            isLessonCompleted = userProgressMap.get(upId) ?? false;
          }
          if (isLessonCompleted) completedLessons++;
        }

        const progressRatio = completedLessons / totalLessons;
        const isCompleted = completedLessons >= totalLessons;

        const cpId = `${userId}_${courseId}`;
        const cpRef = db.collection(`${basePath}/course_progress`).doc(cpId);
        tx.set(cpRef, {
          userId, courseId, completedLessons, totalLessons, progressRatio, isCompleted, updatedAt: new Date(),
        }, { merge: true });
      }
    }
  });

  const superAdmin = req.superAdmin;
  console.log(
    `[SuperAdmin] Student progress updated: tenant=${tenantId} user=${userId} lesson=${lessonId} by ${superAdmin?.email}`
  );

  res.json({ message: "updated" });
});

/**
 * POST /tenants/:tenantId/student-progress/export-sheets
 * 受講状況をGoogleスプレッドシートにエクスポート
 */
router.post("/tenants/:tenantId/student-progress/export-sheets", async (req: Request, res: Response) => {
  const { isWorkspaceIntegrationAvailable } = await import("../services/google-auth.js");
  if (!isWorkspaceIntegrationAvailable()) {
    res.status(503).json({
      error: "workspace_not_available",
      message: "Google Workspace integration is not configured",
    });
    return;
  }

  const db = getFirestore();
  const tenantId = req.params.tenantId as string;
  const courseIdFilter = typeof req.body.courseId === "string" ? req.body.courseId : undefined;

  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }
  const tenantName = tenantDoc.data()?.name ?? tenantId;

  const { usersSnapshot, coursesSnapshot, progressMap, courseProgressMap, lessonsMap } =
    await fetchStudentProgressData(db, tenantId, courseIdFilter);

  // スプレッドシート行データ構築
  const rows: string[][] = [];
  for (const userDoc of usersSnapshot.docs) {
    const userData = userDoc.data();
    const userId = userDoc.id;

    for (const courseDoc of coursesSnapshot) {
      const courseData = courseDoc.data();
      if (!courseData) continue;
      const courseId = courseDoc.id;
      const lessonOrder: string[] = courseData.lessonOrder ?? [];
      const cpKey = `${userId}_${courseId}`;
      const cp = courseProgressMap.get(cpKey);

      for (const lessonId of lessonOrder) {
        const lessonInfo = lessonsMap.get(lessonId);
        const upKey = `${userId}_${lessonId}`;
        const up = progressMap.get(upKey);

        rows.push([
          userData.name ?? "",
          userData.email ?? "",
          courseData.name ?? courseId,
          String(cp?.completedLessons ?? 0),
          String(cp?.totalLessons ?? lessonOrder.length),
          `${((cp?.progressRatio ?? 0) * 100).toFixed(1)}%`,
          cp?.isCompleted ? "完了" : "未完了",
          lessonInfo?.title ?? lessonId,
          up?.videoCompleted ? "完了" : "未完了",
          up?.quizPassed ? "合格" : "未合格",
          up?.quizBestScore !== null && up?.quizBestScore !== undefined ? String(up.quizBestScore) : "",
          up?.lessonCompleted ? "完了" : "未完了",
        ]);
      }
    }
  }

  try {
    const { exportStudentProgressToSheets } = await import("../services/google-sheets-export.js");
    const result = await exportStudentProgressToSheets(tenantName, rows, req.superAdmin!.email);
    res.json(result);
  } catch (e) {
    console.error("[SuperAdmin] Sheets export failed:", e);
    res.status(500).json({
      error: "export_failed",
      message: e instanceof Error ? e.message : "Failed to export to Google Sheets",
    });
  }
});

// ============================================================
// 受講期間管理（テナント×コース単位）
// ============================================================

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?)?$/;

function isValidISODate(value: string): boolean {
  return ISO_DATE_RE.test(value) && !isNaN(new Date(value).getTime());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEnrollmentSettingResponse(data: any): TenantEnrollmentSettingResponse {
  return {
    enrolledAt: data.enrolledAt?.toDate?.()?.toISOString?.() ?? data.enrolledAt ?? "",
    quizAccessUntil: data.quizAccessUntil?.toDate?.()?.toISOString?.() ?? data.quizAccessUntil ?? "",
    videoAccessUntil: data.videoAccessUntil?.toDate?.()?.toISOString?.() ?? data.videoAccessUntil ?? "",
    createdBy: data.createdBy ?? "",
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? data.updatedAt ?? "",
  };
}

const ENROLLEDAT_RANGE_YEARS = 5;

function isEnrolledAtInRange(dateStr: string): boolean {
  const diff = Math.abs(new Date(dateStr).getTime() - Date.now());
  return diff <= ENROLLEDAT_RANGE_YEARS * 365.25 * 24 * 60 * 60 * 1000;
}

/**
 * テナントの受講期間設定を取得
 * GET /super/tenants/:tenantId/enrollment-setting
 */
router.get("/tenants/:tenantId/enrollment-setting", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;

  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }

  const basePath = `tenants/${tenantId}`;
  const doc = await db.collection(`${basePath}/enrollment_setting`).doc("_config").get();

  if (!doc.exists) {
    res.json({ setting: null });
    return;
  }

  res.json({ setting: toEnrollmentSettingResponse(doc.data()) });
});

/**
 * テナントの受講期間設定を作成/更新
 * PUT /super/tenants/:tenantId/enrollment-setting
 * body: { enrolledAt }
 */
router.put("/tenants/:tenantId/enrollment-setting", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;
  const { enrolledAt } = req.body;

  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }

  if (!enrolledAt) {
    res.status(400).json({ error: "bad_request", message: "enrolledAt is required" });
    return;
  }

  if (!isValidISODate(enrolledAt)) {
    res.status(400).json({ error: "invalid_date", message: "enrolledAt must be a valid date string" });
    return;
  }

  if (!isEnrolledAtInRange(enrolledAt)) {
    res.status(400).json({ error: "date_out_of_range", message: `enrolledAt must be within ${ENROLLEDAT_RANGE_YEARS} years from now` });
    return;
  }

  const normalizedEnrolledAt = new Date(enrolledAt).toISOString();
  const deadlines = calculateDefaultDeadlines(normalizedEnrolledAt);
  const basePath = `tenants/${tenantId}`;
  const docRef = db.collection(`${basePath}/enrollment_setting`).doc("_config");

  const settingData = {
    enrolledAt: normalizedEnrolledAt,
    quizAccessUntil: deadlines.quizAccessUntil,
    videoAccessUntil: deadlines.videoAccessUntil,
    createdBy: req.superAdmin!.email,
    updatedAt: new Date().toISOString(),
  };

  await docRef.set(settingData, { merge: true });
  res.json({ setting: toEnrollmentSettingResponse(settingData) });
});

/**
 * テナントの受講期間設定を削除
 * DELETE /super/tenants/:tenantId/enrollment-setting
 */
router.delete("/tenants/:tenantId/enrollment-setting", async (req: Request, res: Response) => {
  const db = getFirestore();
  const tenantId = req.params.tenantId as string;

  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    res.status(404).json({ error: "not_found", message: "Tenant not found" });
    return;
  }

  const basePath = `tenants/${tenantId}`;
  const docRef = db.collection(`${basePath}/enrollment_setting`).doc("_config");
  const doc = await docRef.get();

  if (!doc.exists) {
    res.status(404).json({ error: "not_found", message: "Enrollment setting not found" });
    return;
  }

  await docRef.delete();
  res.status(204).send();
});

export const superAdminRouter = router;
