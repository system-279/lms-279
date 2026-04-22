/**
 * テナント登録API
 * POST /api/v2/tenants - 新規テナント作成
 * GET /api/v2/tenants/mine - 自分のテナント一覧
 */

import { Router, Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import type { TenantMetadata, CreateTenantRequest } from "../types/tenant.js";
import { RESERVED_TENANT_IDS, generateTenantId, validateOrganizationName, normalizeEmail } from "../utils/tenant-id.js";
import { logger } from "../utils/logger.js";

const router = Router();

// ========================================
// レート制限（インメモリ、簡易実装）
// 本番環境ではRedis等に置き換え推奨
// ========================================
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 5; // 1時間あたりの最大テナント作成数
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間

function checkRateLimit(userId: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfterSec };
  }

  entry.count++;
  return { allowed: true };
}

// 定期的に古いエントリをクリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 10 * 60 * 1000); // 10分ごと

/**
 * Firebase認証トークンを検証
 */
async function verifyAuthToken(
  req: Request
): Promise<{ success: true; token: DecodedIdToken } | { success: false; error: string; status: number }> {
  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      success: false,
      error: "認証が必要です。Googleでログインしてください。",
      status: 401,
    };
  }

  const idToken = authHeader.slice(7);
  try {
    // Issue #294 / ADR-031 境界統一:
    //   - checkRevoked=true で revoke 後の既発行トークンを拒否
    //   - email_verified=true と sign_in_provider=google.com を必須化し、
    //     非 Google / 未検証メールでのテナント作成経路をブロックする。
    //   - レスポンスはユーザー列挙防止のため既存の文言「認証トークンが無効です」で統一
    //     （status は tenant-auth.ts と同じ分類で 401: トークン検証失敗 / 403: guard 拒否）、
    //     詳細は構造化 logger.warn に errorType / reason で残す (Issue #292 と同形式)。
    const decodedToken = await getAuth().verifyIdToken(idToken, true);
    if (decodedToken.email_verified !== true) {
      logger.warn("Tenant auth denied: email_not_verified", {
        errorType: "tenant_creation_denied",
        reason: "email_not_verified",
        uid: decodedToken.uid,
        path: req.path,
        method: req.method,
      });
      return {
        success: false,
        error: "認証トークンが無効です。再ログインしてください。",
        status: 403,
      };
    }
    if (decodedToken.firebase?.sign_in_provider !== "google.com") {
      logger.warn("Tenant auth denied: non_google_provider", {
        errorType: "tenant_creation_denied",
        reason: "non_google_provider",
        uid: decodedToken.uid,
        provider: decodedToken.firebase?.sign_in_provider ?? null,
        path: req.path,
        method: req.method,
      });
      return {
        success: false,
        error: "認証トークンが無効です。再ログインしてください。",
        status: 403,
      };
    }
    return { success: true, token: decodedToken };
  } catch (error) {
    // 分類: トークン署名不正/期限切れ/revoke 済み → 401。
    // `email_verified` / `sign_in_provider` ガード拒否（上の 2 分岐）→ 403。
    // `middleware/tenant-auth.ts` の分類（検証失敗 401 / ガード拒否 403）と揃えている。
    const err = error as { code?: unknown; message?: unknown };
    logger.error("Tenant token verification failed", {
      errorType: "tenant_token_error",
      firebaseErrorCode: typeof err.code === "string" ? err.code : null,
      errorMessage: typeof err.message === "string" ? err.message : String(error),
      path: req.path,
      method: req.method,
    });
    return {
      success: false,
      error: "認証トークンが無効です。再ログインしてください。",
      status: 401,
    };
  }
}

// ========================================
// APIエンドポイント
// ========================================

/**
 * テナント作成
 * POST /api/v2/tenants
 *
 * 認証必須: Firebase ID Token
 * リクエストボディ: { name: string }
 *
 * レート制限: 1ユーザーあたり1時間に5回まで
 */
router.post("/", async (req: Request, res: Response) => {
  const startTime = Date.now();

  // 1. 認証チェック
  const authResult = await verifyAuthToken(req);
  if (!authResult.success) {
    res.status(authResult.status).json({
      error: "unauthorized",
      message: authResult.error,
    });
    return;
  }

  const { uid, email, name: userName } = authResult.token;
  if (!email) {
    res.status(400).json({
      error: "email_required",
      message: "メールアドレスが取得できませんでした。",
    });
    return;
  }

  const normalizedEmail = normalizeEmail(email);

  // 2. レート制限チェック
  const rateLimit = checkRateLimit(uid);
  if (!rateLimit.allowed) {
    console.warn(`Rate limit exceeded for user ${uid}`);
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: `テナント作成の上限に達しました。${rateLimit.retryAfterSec}秒後に再試行してください。`,
      retryAfterSec: rateLimit.retryAfterSec,
    });
    return;
  }

  // 3. リクエストボディのバリデーション
  const body = req.body as CreateTenantRequest;
  const organizationName = validateOrganizationName(body.name);
  if (!organizationName) {
    res.status(400).json({
      error: "invalid_name",
      message: "組織名は1〜100文字で入力してください。",
    });
    return;
  }

  const db = getFirestore();
  let tenantId: string = "";
  let attempts = 0;
  const maxAttempts = 10;

  // 4. ユニークなテナントIDを生成（衝突時はリトライ）
  while (attempts < maxAttempts) {
    tenantId = generateTenantId();
    const existingDoc = await db.collection("tenants").doc(tenantId).get();
    if (!existingDoc.exists) {
      break;
    }
    attempts++;
    console.warn(`Tenant ID collision: ${tenantId}, attempt ${attempts}`);
  }

  if (attempts >= maxAttempts) {
    console.error(`Failed to generate unique tenant ID after ${maxAttempts} attempts`);
    res.status(500).json({
      error: "id_generation_failed",
      message: "テナントIDの生成に失敗しました。再度お試しください。",
    });
    return;
  }

  const now = new Date();

  // 5. トランザクションでテナント作成
  try {
    await db.runTransaction(async (transaction) => {
      // 5.1 テナントメタデータを作成
      const tenantRef = db.collection("tenants").doc(tenantId);
      const tenantData: Omit<TenantMetadata, "id"> = {
        name: organizationName,
        ownerId: uid,
        ownerEmail: normalizedEmail,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      transaction.set(tenantRef, { id: tenantId, ...tenantData });

      // 5.2 許可リストにオーナーのメールを追加
      const allowedEmailRef = db
        .collection("tenants")
        .doc(tenantId)
        .collection("allowed_emails")
        .doc();
      transaction.set(allowedEmailRef, {
        id: allowedEmailRef.id,
        email: normalizedEmail,
        note: "オーナー（自動登録）",
        createdAt: now,
      });

      // 5.3 初期管理者ユーザーを作成
      const userRef = db
        .collection("tenants")
        .doc(tenantId)
        .collection("users")
        .doc();
      transaction.set(userRef, {
        id: userRef.id,
        email: normalizedEmail,
        name: userName ?? null,
        role: "admin",
        firebaseUid: uid,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (txError) {
    console.error("Transaction failed:", txError);
    res.status(500).json({
      error: "transaction_failed",
      message: "テナントの作成中にエラーが発生しました。再度お試しください。",
    });
    return;
  }

  const tenant: TenantMetadata = {
    id: tenantId,
    name: organizationName,
    ownerId: uid,
    ownerEmail: normalizedEmail,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const duration = Date.now() - startTime;
  console.log(`Tenant created: ${tenantId} (${organizationName}) by ${normalizedEmail} in ${duration}ms`);

  res.status(201).json({
    tenant,
    adminUrl: `/${tenantId}/admin`,
    studentUrl: `/${tenantId}/student`,
  });
});

/**
 * 自分が所有するテナント一覧を取得
 * GET /api/v2/tenants/mine
 *
 * 認証必須: Firebase ID Token
 * クエリ: status (optional) - "active" | "suspended"
 */
router.get("/mine", async (req: Request, res: Response) => {
  // 1. 認証チェック
  const authResult = await verifyAuthToken(req);
  if (!authResult.success) {
    res.status(authResult.status).json({
      error: "unauthorized",
      message: authResult.error,
    });
    return;
  }

  const { uid } = authResult.token;

  // 2. クエリパラメータ
  const statusFilter = req.query.status as string | undefined;
  const validStatuses = ["active", "suspended"];
  if (statusFilter && !validStatuses.includes(statusFilter)) {
    res.status(400).json({
      error: "invalid_status",
      message: "statusは 'active' または 'suspended' を指定してください。",
    });
    return;
  }

  // 3. テナント一覧を取得
  const db = getFirestore();
  let query = db.collection("tenants").where("ownerId", "==", uid);

  if (statusFilter) {
    query = query.where("status", "==", statusFilter);
  }

  const snapshot = await query.orderBy("createdAt", "desc").get();

  const tenants = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: data.id,
      name: data.name,
      ownerEmail: data.ownerEmail,
      status: data.status,
      createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  res.json({ tenants });
});

/**
 * 予約済みテナントID一覧を取得（デバッグ用）
 * GET /api/v2/tenants/reserved
 */
router.get("/reserved", (_req: Request, res: Response) => {
  res.json({
    reserved: Array.from(RESERVED_TENANT_IDS),
  });
});

export const tenantsRouter = router;
