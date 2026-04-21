/**
 * テナント対応認証ミドルウェア
 * DataSourceを使用してテナントスコープの認証を行う
 */

import type { Request, Response, NextFunction } from "express";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import type { AuthUser } from "./auth.js";
import { isSuperAdmin } from "./super-admin.js";
import { logger } from "../utils/logger.js";

// Express Request を拡張（スーパー管理者フラグ）
declare global {
  namespace Express {
    interface Request {
      isSuperAdminAccess?: boolean;
    }
  }
}

const authMode = process.env.AUTH_MODE ?? "dev";

// Firebase Admin SDK初期化（firebase モードの場合のみ）
if (authMode === "firebase" && getApps().length === 0) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      projectId,
    });
  } else {
    initializeApp({ projectId });
  }
}

/**
 * アクセス拒否エラー
 */
export class TenantAccessDeniedError extends Error {
  email?: string;
  tenantId?: string;

  constructor(message: string, email?: string, tenantId?: string) {
    super(message);
    this.name = "TenantAccessDeniedError";
    this.email = email;
    this.tenantId = tenantId;
  }
}

/**
 * テナントアクセス拒否エラーをログ出力してレスポンスを返す
 * Firestoreに認証エラーログを保存（非同期、エラーでも処理を止めない）
 */
/**
 * テナントアクセス拒否時の共通ハンドラ。
 *
 * - レスポンス `message` はユーザー列挙防止のため固定の一般化文言。
 * - 詳細な email / tenantId / 原因メッセージは logger.warn と
 *   auth_error_logs コレクションに記録される。
 *
 * `export` しているのは単体テスト（tenant-auth-error-response.test.ts）から
 * 直接呼び出すためで、外部モジュールから通常の経路として呼ぶことは想定していない。
 */
export async function handleTenantAccessDenied(
  error: TenantAccessDeniedError,
  req: Request,
  res: Response
): Promise<void> {
  const tenantId = error.tenantId ?? req.tenantContext?.tenantId ?? "unknown";
  const email = error.email ?? "unknown";

  logger.warn("Tenant access denied", {
    errorType: "tenant_access_denied",
    tenantId,
    email,
    path: req.path,
    method: req.method,
    userAgent: req.header("user-agent"),
  });

  // Firestoreに認証エラーログを保存（非同期、失敗しても処理を止めない）
  if (req.dataSource) {
    try {
      await req.dataSource.createAuthErrorLog({
        email,
        tenantId,
        errorType: "tenant_access_denied",
        errorMessage: error.message,
        path: req.path,
        method: req.method,
        userAgent: req.header("user-agent") ?? null,
        ipAddress: req.ip ?? null,
        occurredAt: new Date().toISOString(),
      });
    } catch (logError) {
      // ログ保存失敗は警告のみ、レスポンスには影響させない
      logger.warn("Failed to save auth error log", { error: logError });
    }
  }

  // ユーザー列挙防止のためレスポンス文言は一般化する。
  // 詳細（email/tenantId/原因メッセージ）は logger.warn と auth_error_logs に記録済み。
  res.status(403).json({
    error: "tenant_access_denied",
    message: "アクセス権限がありません。管理者にお問い合わせください。",
  });
}

/**
 * テナントスコープでユーザーを検索、なければ自動作成
 * 許可リストに含まれていない場合はエラー
 * スーパー管理者は許可リストに関係なくアクセス可能
 */
/**
 * 既存ユーザーにスーパー管理者オーバーライドを適用してAuthUserを構築
 */
function buildAuthUser(
  req: Request,
  user: { id: string; role: "admin" | "teacher" | "student"; email?: string | null },
  superAdminAccess: boolean,
  extra?: { firebaseUid?: string }
): AuthUser {
  if (superAdminAccess) {
    req.isSuperAdminAccess = true;
  }
  return {
    id: user.id,
    role: superAdminAccess ? "admin" : user.role,
    email: user.email ?? undefined,
    ...extra,
  };
}

/**
 * スーパー管理者チェック（失敗時はfalseを返し、テナントroleで続行）
 */
async function checkSuperAdmin(email: string | undefined): Promise<boolean> {
  try {
    return await isSuperAdmin(email);
  } catch (error) {
    logger.error("Super admin check failed, proceeding with tenant role", {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function findOrCreateTenantUser(
  req: Request,
  decodedToken: DecodedIdToken
): Promise<AuthUser> {
  const ds = req.dataSource!;
  const uid = decodedToken.uid;
  const email = decodedToken.email?.trim().toLowerCase();

  // firebaseUidでユーザーを検索（テナント内の既存ユーザーは常に許可）
  const existingByUid = await ds.getUserByFirebaseUid(uid);
  if (existingByUid) {
    // 既にadminならスーパー管理者チェック不要
    const superAdminAccess = existingByUid.role === "admin"
      ? false
      : await checkSuperAdmin(email);
    return buildAuthUser(req, existingByUid, superAdminAccess, { firebaseUid: uid });
  }

  // メールアドレスで既存ユーザーを検索（firebaseUidがまだ設定されていない場合）
  if (email) {
    const existingByEmail = await ds.getUserByEmail(email);
    if (existingByEmail) {
      // firebaseUidを設定
      await ds.updateUser(existingByEmail.id, { firebaseUid: uid });
      const superAdminAccess = existingByEmail.role === "admin"
        ? false
        : await checkSuperAdmin(email);
      return buildAuthUser(req, existingByEmail, superAdminAccess, { firebaseUid: uid });
    }
  }

  // テナント内にユーザーが存在しない場合 — スーパー管理者なら仮想adminユーザーとして返す
  const superAdminAccess = await checkSuperAdmin(email);
  if (superAdminAccess) {
    req.isSuperAdminAccess = true;
    return {
      id: `super-admin-${uid}`,
      role: "admin",
      email: email ?? undefined,
      firebaseUid: uid,
    };
  }

  // 新規ユーザーの場合、テナントの許可リストをチェック
  const allowed = email ? await ds.isEmailAllowed(email) : false;
  if (!allowed) {
    const tenantId = req.tenantContext?.tenantId ?? "unknown";
    throw new TenantAccessDeniedError(
      `このメールアドレス (${email ?? "未設定"}) はテナント「${tenantId}」へのアクセスが許可されていません。管理者に連絡してください。`,
      email ?? undefined,
      tenantId
    );
  }

  // テナント内に新規ユーザー作成（初回ログイン）
  // email は isEmailAllowed チェックを通過した時点で必ず存在する
  const user = await ds.createUser({
    email: email!,
    name: decodedToken.name ?? null,
    role: "student",
    firebaseUid: uid,
  });

  return {
    id: user.id,
    role: user.role,
    email: user.email ?? undefined,
    firebaseUid: uid,
  };
}

/**
 * 開発モードでのテナントスコープユーザー検索/作成
 * スーパー管理者は許可リストに関係なくアクセス可能（テナント内にユーザーがいない場合のみ）
 */
async function findOrCreateDevUser(
  req: Request,
  email: string,
  requestedRole: "admin" | "teacher" | "student"
): Promise<AuthUser | null> {
  const ds = req.dataSource!;

  // メールアドレスで既存ユーザーを検索（テナント内にユーザーがいれば優先）
  const existingByEmail = await ds.getUserByEmail(email);
  if (existingByEmail) {
    // 既にadminならスーパー管理者チェック不要
    const superAdminAccess = existingByEmail.role === "admin"
      ? false
      : await checkSuperAdmin(email);
    return buildAuthUser(req, existingByEmail, superAdminAccess);
  }

  // テナント内にユーザーが存在しない場合 — スーパー管理者なら仮想adminユーザーとして返す
  const superAdminAccess = await checkSuperAdmin(email);
  if (superAdminAccess) {
    req.isSuperAdminAccess = true;
    return {
      id: `super-admin-dev-${email.replace(/[^a-zA-Z0-9]/g, "-")}`,
      role: "admin",
      email,
    };
  }

  // 新規ユーザーの場合、テナントの許可リストをチェック
  const allowed = await ds.isEmailAllowed(email);
  if (!allowed) {
    const tenantId = req.tenantContext?.tenantId ?? "unknown";
    throw new TenantAccessDeniedError(
      `このメールアドレス (${email}) はテナント「${tenantId}」へのアクセスが許可されていません。`,
      email,
      tenantId
    );
  }

  // テナント内に新規ユーザー作成
  const user = await ds.createUser({
    email,
    name: null,
    role: requestedRole,
  });

  return {
    id: user.id,
    role: user.role,
    email: user.email ?? undefined,
  };
}

/**
 * テナント対応認証ミドルウェア
 * req.dataSource を使用してテナントスコープの認証を行う
 *
 * 前提: tenantMiddleware が先に実行されていること
 */
export const tenantAwareAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Skip if user is already set (e.g., demo mode)
  if (req.user) {
    return next();
  }

  // DataSourceが設定されていない場合はエラー
  if (!req.dataSource) {
    return res.status(500).json({
      error: "internal_error",
      message: "DataSource not configured",
    });
  }

  if (authMode === "dev") {
    // 開発モード: ヘッダ疑似認証（X-User-Id, X-User-Role, X-User-Email）
    const headerId = req.header("x-user-id");
    const headerRole = (req.header("x-user-role") as "admin" | "teacher" | "student" | null) ?? "student";
    const headerEmail = req.header("x-user-email");

    // ヘッダにIDが指定されている場合は直接使用（テスト用）
    if (headerId) {
      // テナント内のユーザーとして検証
      const existingUser = await req.dataSource.getUserById(headerId);
      if (existingUser) {
        req.user = {
          id: existingUser.id,
          role: existingUser.role,
          email: existingUser.email ?? undefined,
        };
        return next();
      }

      // ユーザーが見つからない場合、メールがあれば検索/作成
      if (headerEmail) {
        try {
          const user = await findOrCreateDevUser(req, headerEmail, headerRole);
          if (user) {
            req.user = user;
          }
        } catch (error) {
          if (error instanceof TenantAccessDeniedError) {
            await handleTenantAccessDenied(error, req, res);
            return;
          }
          throw error;
        }
      }
      return next();
    }

    // メールアドレスのみ指定の場合
    if (headerEmail) {
      try {
        const user = await findOrCreateDevUser(req, headerEmail, headerRole);
        if (user) {
          req.user = user;
        }
      } catch (error) {
        if (error instanceof TenantAccessDeniedError) {
          await handleTenantAccessDenied(error, req, res);
          return;
        }
        throw error;
      }
    }
    return next();
  }

  if (authMode === "firebase") {
    // Firebase認証: Authorization: Bearer <ID Token>
    const authHeader = req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return next();
    }

    const idToken = authHeader.slice(7);
    try {
      const decodedToken = await getAuth().verifyIdToken(idToken);
      req.user = await findOrCreateTenantUser(req, decodedToken);
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        await handleTenantAccessDenied(error, req, res);
        return;
      }
      // トークン検証失敗時は req.user を設定しない（401はrequireUserで処理）
      console.error("Firebase token verification failed:", error);
    }
    return next();
  }

  // 不明なAUTH_MODEの場合
  next();
};
