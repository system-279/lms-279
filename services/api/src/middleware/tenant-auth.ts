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
 *
 * `reason` は Issue #292 で導入: Cloud Logging / auth_error_logs 上で拒否理由を
 * 機械的に区別可能にするため、分岐ごとに固定の文字列を付与する。
 * レスポンス文言はユーザー列挙防止のため共通化するが、reason はログ専用フィールド。
 */
export type TenantAccessDenialReason =
  | "email_not_verified"
  | "non_google_provider"
  | "email_missing"
  | "not_in_allowlist";

export class TenantAccessDeniedError extends Error {
  email?: string;
  tenantId?: string;
  reason: TenantAccessDenialReason;

  constructor(
    message: string,
    reason: TenantAccessDenialReason,
    email?: string,
    tenantId?: string
  ) {
    super(message);
    this.name = "TenantAccessDeniedError";
    this.email = email;
    this.tenantId = tenantId;
    this.reason = reason;
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
    reason: error.reason,
    tenantId,
    email,
    path: req.path,
    method: req.method,
    userAgent: req.header("user-agent"),
    ipAddress: req.ip,
  });

  // Firestoreに認証エラーログを保存（非同期、失敗しても処理を止めない）
  if (req.dataSource) {
    try {
      await req.dataSource.createAuthErrorLog({
        email,
        tenantId,
        errorType: "tenant_access_denied",
        reason: error.reason,
        errorMessage: error.message,
        path: req.path,
        method: req.method,
        userAgent: req.header("user-agent") ?? null,
        ipAddress: req.ip ?? null,
        firebaseErrorCode: null,
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

/**
 * 継続的認可境界（ADR-006 / ADR-031 必須条件 #5）：
 * allowed_emails を毎リクエスト再チェックし、未登録なら TenantAccessDeniedError を投げる。
 *
 * スーパー管理者は呼び出し側で判定済みの前提（本関数では判定しない）。
 * 既存ユーザー経路（firebaseUid 一致 / email 一致 / x-user-id 一致）でも、
 * allowed_emails から email が削除されていれば次回リクエストで 403 を返すことで、
 * 「削除後の既存セッション継続」を防ぐ。
 */
async function ensureAllowlisted(
  req: Request,
  email: string | undefined
): Promise<void> {
  const ds = req.dataSource!;
  const allowed = email ? await ds.isEmailAllowed(email) : false;
  if (!allowed) {
    const tenantId = req.tenantContext?.tenantId ?? "unknown";
    // email 不在時は運用診断のため WARN を追加で出す（403 の原因が「未登録」か「email 未設定」かを切り分け）。
    // auth_error_logs には handleTenantAccessDenied 側で記録されるため、ここでは application log のみ。
    if (!email) {
      logger.warn("Allowlist check skipped due to missing email", {
        tenantId,
        path: req.path,
      });
    }
    throw new TenantAccessDeniedError(
      `このメールアドレス (${email ?? "未設定"}) はテナント「${tenantId}」へのアクセスが許可されていません。`,
      email ? "not_in_allowlist" : "email_missing",
      email ?? undefined,
      tenantId
    );
  }
}

/**
 * DB ユーザー email を allowlist チェック用に正規化する。
 * 初期投入時に大文字/前後空白が残っている既存データへの防御的処理。
 * 詳細: ADR-031 必須条件 #3（`.trim().toLowerCase()` のみ適用）。
 */
function normalizeStoredEmail(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

async function findOrCreateTenantUser(
  req: Request,
  decodedToken: DecodedIdToken
): Promise<AuthUser> {
  const ds = req.dataSource!;
  const uid = decodedToken.uid;
  const email = decodedToken.email?.trim().toLowerCase();
  const tenantId = req.tenantContext?.tenantId;

  // Issue #286 / ADR-031 allowed_emails 境界:
  //   #1: email_verified=true 必須（未検証メール詐称の防止）
  //   #2: sign_in_provider=google.com のみ許可（IdP 追加時の allowlist バイパス防止）
  // 既存ユーザー検索/ super-admin チェックより前に実行し、ホワイトリスト主義を徹底する。
  // レスポンスは handleTenantAccessDenied 経由の固定 403 文言でユーザー列挙を防ぐ。
  if (decodedToken.email_verified !== true) {
    throw new TenantAccessDeniedError(
      `Email verification required (email=${email ?? "unknown"})`,
      "email_not_verified",
      email,
      tenantId
    );
  }
  const signInProvider = decodedToken.firebase?.sign_in_provider;
  if (signInProvider !== "google.com") {
    throw new TenantAccessDeniedError(
      `Only Google sign-in is allowed (provider=${signInProvider ?? "unknown"})`,
      "non_google_provider",
      email,
      tenantId
    );
  }

  // firebaseUidでユーザーを検索（継続的認可境界: allowed_emails を毎リクエスト再チェック）
  const existingByUid = await ds.getUserByFirebaseUid(uid);
  if (existingByUid) {
    // allowlist バイパスは super admin のみの特権なので、role にかかわらず判定する。
    // （旧実装は role=admin で checkSuperAdmin をスキップしており、admin role の
    //   super admin が allowlist 再チェックに引っかかる不整合があった）
    const superAdminAccess = await checkSuperAdmin(email);
    if (!superAdminAccess) {
      await ensureAllowlisted(req, email ?? normalizeStoredEmail(existingByUid.email));
    }
    return buildAuthUser(req, existingByUid, superAdminAccess, { firebaseUid: uid });
  }

  // メールアドレスで既存ユーザーを検索（firebaseUidがまだ設定されていない場合）
  if (email) {
    const existingByEmail = await ds.getUserByEmail(email);
    if (existingByEmail) {
      const superAdminAccess = await checkSuperAdmin(email);
      // firebaseUid 設定前に authorization を確定させる（未許可ユーザーにUIDを書き込まない）
      if (!superAdminAccess) {
        await ensureAllowlisted(req, email);
      }
      await ds.updateUser(existingByEmail.id, { firebaseUid: uid });
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
      email ? "not_in_allowlist" : "email_missing",
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

  // メールアドレスで既存ユーザーを検索（継続的認可境界: allowed_emails を毎リクエスト再チェック）
  const existingByEmail = await ds.getUserByEmail(email);
  if (existingByEmail) {
    // allowlist バイパスは super admin のみ（role=admin は全テナントバイパスではない）
    const superAdminAccess = await checkSuperAdmin(email);
    if (!superAdminAccess) {
      await ensureAllowlisted(req, email);
    }
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
      "not_in_allowlist",
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
        // 継続的認可境界: dev 経路でも production と同等に allowlist を再チェック。
        // スーパー管理者判定用 email は、ヘッダ email を優先し、なければ DB email を正規化して使用。
        const resolvedEmail =
          normalizeStoredEmail(headerEmail) ?? normalizeStoredEmail(existingUser.email);
        // allowlist バイパスは super admin のみ（role=admin は allowlist 対象）
        const superAdminAccess = await checkSuperAdmin(resolvedEmail);
        if (!superAdminAccess) {
          // この分岐は `return next()` で即完了するため、
          // 403 応答後に next() が踏まれないようこの経路固有で try-catch する。
          try {
            await ensureAllowlisted(req, resolvedEmail);
          } catch (error) {
            if (error instanceof TenantAccessDeniedError) {
              await handleTenantAccessDenied(error, req, res);
              return;
            }
            throw error;
          }
        }
        req.user = buildAuthUser(req, existingUser, superAdminAccess);
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
      // 第2引数 checkRevoked=true により、revokeRefreshTokens 後の既発行 ID token も
      // auth/id-token-revoked で拒否される（B-1「即時失効」の実効性担保）。
      const decodedToken = await getAuth().verifyIdToken(idToken, true);
      req.user = await findOrCreateTenantUser(req, decodedToken);
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        await handleTenantAccessDenied(error, req, res);
        return;
      }
      // トークン検証失敗時は req.user を設定しない（401はrequireUserで処理）。
      // Issue #292: Cloud Logging でフィルタ可能な構造化ログに切り替え、
      // firebaseErrorCode (auth/id-token-revoked など) で原因を機械的に区別する。
      const err = error as { code?: unknown; message?: unknown };
      logger.error("Tenant token verification failed", {
        errorType: "tenant_token_error",
        firebaseErrorCode: typeof err.code === "string" ? err.code : null,
        errorMessage: typeof err.message === "string" ? err.message : String(error),
        tenantId: req.tenantContext?.tenantId ?? "unknown",
        path: req.path,
        method: req.method,
        ipAddress: req.ip,
      });
    }
    return next();
  }

  // 不明なAUTH_MODEの場合
  next();
};
