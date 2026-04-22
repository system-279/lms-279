/**
 * スーパー管理者認可ミドルウェア
 * Firestoreまたは環境変数で指定されたメールアドレスのみアクセスを許可
 */

import type { Request, Response, NextFunction } from "express";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "../utils/logger.js";
import { getPlatformDataSource, PLATFORM_TENANT_ID } from "./platform-datasource.js";

/**
 * Super admin 経路の拒否理由（Issue #292）。
 * Cloud Logging / platform_auth_error_logs で機械的にフィルタ可能にするため固定値で列挙する。
 */
export type SuperAdminDenialReason =
  | "no_auth_header"
  | "email_not_verified"
  | "non_google_provider"
  | "email_missing"
  | "not_super_admin";

/**
 * Super admin 経路の認証拒否/エラーを構造化ログ + platform_auth_error_logs に記録する (Issue #292)。
 * - `logger.warn`: 403 分岐（拒否理由を reason で区別）
 * - `logger.error`: catch 節（firebaseErrorCode 付き）
 *
 * Firestore 書き込みは失敗しても API 応答を止めない（logger.warn だけ残す）。
 * `req.dataSource` は super-admin 経路では注入されないため、`getPlatformDataSource()` 経由でアクセスする。
 */
async function recordSuperAdminAuthEvent(
  req: Request,
  payload: {
    errorType: "super_admin_denied" | "super_admin_token_error";
    reason: SuperAdminDenialReason | null;
    email: string | undefined;
    errorMessage: string;
    firebaseErrorCode: string | null;
  }
): Promise<void> {
  const logFields = {
    errorType: payload.errorType,
    reason: payload.reason,
    email: payload.email ?? "unknown",
    firebaseErrorCode: payload.firebaseErrorCode,
    path: req.path,
    method: req.method,
    userAgent: req.header("user-agent"),
    ipAddress: req.ip,
  };
  if (payload.errorType === "super_admin_denied") {
    logger.warn("Super admin access denied", logFields);
  } else {
    logger.error("Super admin token verification failed", logFields);
  }

  try {
    const ds = getPlatformDataSource();
    await ds.createPlatformAuthErrorLog({
      email: payload.email ?? "unknown",
      tenantId: PLATFORM_TENANT_ID,
      errorType: payload.errorType,
      reason: payload.reason,
      errorMessage: payload.errorMessage,
      path: req.path,
      method: req.method,
      userAgent: req.header("user-agent") ?? null,
      ipAddress: req.ip ?? null,
      firebaseErrorCode: payload.firebaseErrorCode,
      occurredAt: new Date().toISOString(),
    });
  } catch (persistError) {
    // Issue #292 silent-failure 指摘 C-1 対応: persist 失敗時に元イベントコンテキスト
    // (errorType/reason/email/firebaseErrorCode/path 等) が logger.warn の "error" フィールド
    // だけに畳み込まれて落ちると、Firestore 障害中の拒否イベントが完全に失われる。
    // 元 payload を展開して logger.error に残し、最低限 application log での forensics を維持する。
    const pe = persistError as { code?: unknown };
    logger.error("Failed to persist platform auth error log", {
      originalErrorType: payload.errorType,
      originalReason: payload.reason,
      email: payload.email ?? "unknown",
      firebaseErrorCode: payload.firebaseErrorCode,
      path: req.path,
      method: req.method,
      ipAddress: req.ip,
      persistErrorCode: typeof pe.code === "string" ? pe.code : null,
      persistErrorMessage:
        persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
}

const authMode = process.env.AUTH_MODE ?? "dev";

// Issue #290 / ADR-031: 本番 runtime では AUTH_MODE=firebase を必須化。
// super-admin 経路も dev モードでは X-User-Email を無検証で信頼するため、同等の
// fail-fast ガードが必要。tenant-auth.ts と独立モジュールのため両方で assertion する。
// 本番 runtime 判定は tenant-auth.ts と同じロジック: NODE_ENV 正規化 + Cloud Run
// の K_SERVICE 自動注入を併用し、どちらか一方でも本番と判定されたら発火する。
// 詳細: docs/runbook/auth-mode-production-check.md
if (isProductionRuntime() && authMode !== "firebase") {
  throw new Error(
    `FATAL: AUTH_MODE must be "firebase" in production (got "${authMode}"). ` +
      `Super-admin endpoints would accept unverified X-User-Email headers. ` +
      `Check Cloud Run env vars or IaC configuration (docs/runbook/auth-mode-production-check.md).`
  );
}

function isProductionRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === "production") return true;
  if (typeof process.env.K_SERVICE === "string" && process.env.K_SERVICE.length > 0) return true;
  return false;
}

// 環境変数からのスーパー管理者（フォールバック/ブートストラップ用）
const envSuperAdminEmails: string[] = (process.env.SUPER_ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter((email) => email.length > 0);

// Firebase Admin SDK初期化（firebase モードの場合のみ、未初期化の場合）
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
 * スーパー管理者情報をリクエストに付与するための型拡張
 */
export interface SuperAdminUser {
  email: string;
  firebaseUid?: string;
}

declare global {
  namespace Express {
    interface Request {
      superAdmin?: SuperAdminUser;
    }
  }
}

/**
 * Firestore アクセスが一時的に失敗した場合に throw される識別可能エラー (Issue #293)。
 * 呼び出し側（super-admin middleware）で catch し 503 として返すためのマーカー。
 *
 * `Error.cause` (ES2022) に原因例外を保持しており、Sentry などで stack chain を
 * 追跡可能。`code` は Firebase Admin SDK の Firestore エラーコード文字列
 * （"unavailable", "deadline-exceeded", "permission-denied", etc.）が入る。
 */
export class SuperAdminFirestoreUnavailableError extends Error {
  readonly code: string | undefined;
  constructor(cause: unknown) {
    const c = cause as { code?: string } | undefined;
    super(`SUPER_ADMIN_FIRESTORE_UNAVAILABLE: ${c?.code ?? "unknown"}`, { cause });
    this.name = "SuperAdminFirestoreUnavailableError";
    this.code = typeof c?.code === "string" ? c.code : undefined;
  }
}

/**
 * Firestoreからスーパー管理者一覧を取得
 *
 * Issue #293: Firestore 障害時に空配列を返すと、登録 super-admin が silent に
 * 403 で締め出されて「権限剥奪？」と誤認される事故につながる。
 * エラーを SuperAdminFirestoreUnavailableError として上位に伝播させ、
 * 呼び出し側で 503 Service Unavailable を返す設計に変更する。
 *
 * ログは呼び出し側（superAdminAuthMiddleware）で一本化するため、ここでは出力しない。
 */
export async function getSuperAdminsFromFirestore(): Promise<string[]> {
  try {
    const db = getFirestore();
    const snapshot = await db.collection("superAdmins").get();
    return snapshot.docs.map((doc) => doc.id.toLowerCase());
  } catch (error) {
    throw new SuperAdminFirestoreUnavailableError(error);
  }
}

/**
 * メールアドレスがスーパー管理者か判定（環境変数 + Firestore両方チェック）
 *
 * env フォールバックに載っている場合は Firestore アクセスなしで true を返す（高速パス）。
 * Firestore 障害時は SuperAdminFirestoreUnavailableError を throw するため、
 * 呼び出し側で catch して 503 として返却する必要がある。
 */
export async function isSuperAdmin(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  const normalizedEmail = email.toLowerCase();

  // 環境変数でチェック（高速パス。Firestore 障害でも通過する）
  if (envSuperAdminEmails.includes(normalizedEmail)) {
    return true;
  }

  // Firestore でチェック（障害時は throw → 呼び出し側で 503）
  const firestoreAdmins = await getSuperAdminsFromFirestore();
  return firestoreAdmins.includes(normalizedEmail);
}

/**
 * スーパー管理者をFirestoreに追加
 */
export async function addSuperAdmin(email: string, addedBy: string): Promise<void> {
  const db = getFirestore();
  const normalizedEmail = email.toLowerCase();
  await db.collection("superAdmins").doc(normalizedEmail).set({
    email: normalizedEmail,
    addedBy,
    addedAt: new Date().toISOString(),
  });
  logger.info("Super admin added", { email: normalizedEmail, addedBy });
}

/**
 * スーパー管理者をFirestoreから削除
 */
export async function removeSuperAdmin(email: string): Promise<void> {
  const db = getFirestore();
  const normalizedEmail = email.toLowerCase();
  await db.collection("superAdmins").doc(normalizedEmail).delete();
  logger.info("Super admin removed", { email: normalizedEmail });
}

export type SuperAdminRecord = {
  email: string;
  source: "env" | "firestore";
  addedAt?: string;
  addedBy?: string;
};

/**
 * env + Firestore snapshot からスーパー管理者一覧を構築する private helper。
 *
 * Issue #296: `getAllSuperAdmins` (silent fallback) と `getAllSuperAdminsStrict`
 * (fail-closed) で内部ループが完全一致していた負債を解消する共通化。catch の
 * 扱いだけを各公開関数で変え、ループ本体の同期漏れリスクをなくす。
 */
function buildSuperAdminList(
  snapshot: FirebaseFirestore.QuerySnapshot
): SuperAdminRecord[] {
  const result: SuperAdminRecord[] = [];

  for (const email of envSuperAdminEmails) {
    result.push({ email, source: "env" });
  }

  for (const doc of snapshot.docs) {
    const data = doc.data();
    // 環境変数と重複していない場合のみ追加（env 側を優先）
    if (!envSuperAdminEmails.includes(doc.id)) {
      result.push({
        email: doc.id,
        source: "firestore",
        addedAt: data.addedAt,
        addedBy: data.addedBy,
      });
    }
  }

  return result;
}

/**
 * 全スーパー管理者一覧を取得（環境変数 + Firestore）
 *
 * Issue #296: Firestore 障害時の挙動は「silent fallback（env 分のみ返却）」を
 * 維持する（UI 一覧表示の可用性優先）。ただし破壊的操作（削除 / 追加）では
 * silent に env 以外が消えた状態で find() に通すと 404 誤認事故につながるため、
 * そちら用には {@link getAllSuperAdminsStrict} を使う。
 *
 * console.error から logger.error に移行し、Issue #292 の構造化ログ形式に揃える
 * （firebaseErrorCode / errorMessage を Cloud Logging で串刺し可能）。
 */
export async function getAllSuperAdmins(): Promise<SuperAdminRecord[]> {
  try {
    const db = getFirestore();
    const snapshot = await db.collection("superAdmins").get();
    return buildSuperAdminList(snapshot);
  } catch (error) {
    const err = error as { code?: unknown; message?: unknown };
    logger.error("Failed to fetch super admins from Firestore (silent fallback)", {
      errorType: "super_admin_list_firestore_fallback",
      firebaseErrorCode: typeof err.code === "string" ? err.code : null,
      errorMessage: typeof err.message === "string" ? err.message : String(error),
    });
    // env 分だけで一覧を返す（UI ロード失敗回避のための UX 優先）
    return envSuperAdminEmails.map((email) => ({ email, source: "env" }) as const);
  }
}

/**
 * 全スーパー管理者一覧を fail-closed で取得する（Issue #296）。
 *
 * Firestore 障害時に {@link SuperAdminFirestoreUnavailableError} を throw する。
 * 破壊的操作（削除・追加）の前段で「env 分のみ」に縮退した状態で find() に
 * 通すと、実在する firestore admin を 404 で「見つからない」と誤認させ
 * インシデント時に危険な操作判断につながるため、これらの経路では本関数を使う。
 */
export async function getAllSuperAdminsStrict(): Promise<SuperAdminRecord[]> {
  try {
    const db = getFirestore();
    const snapshot = await db.collection("superAdmins").get();
    return buildSuperAdminList(snapshot);
  } catch (error) {
    throw new SuperAdminFirestoreUnavailableError(error);
  }
}

/**
 * スーパー管理者認可ミドルウェア
 * Firebase認証後、メールアドレスがスーパー管理者かチェック
 */
export const superAdminAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (authMode === "dev") {
    // 開発モード: X-User-Email ヘッダでスーパー管理者判定
    const headerEmail = req.header("x-user-email");

    if (!headerEmail) {
      await recordSuperAdminAuthEvent(req, {
        errorType: "super_admin_denied",
        reason: "no_auth_header",
        email: undefined,
        errorMessage: "X-User-Email header missing (dev mode)",
        firebaseErrorCode: null,
      });
      return res.status(401).json({
        error: "unauthorized",
        message: "認証情報がありません",
      });
    }

    try {
      const isAdmin = await isSuperAdmin(headerEmail);
      if (!isAdmin) {
        await recordSuperAdminAuthEvent(req, {
          errorType: "super_admin_denied",
          reason: "not_super_admin",
          email: headerEmail,
          errorMessage: "Email not registered as super admin (dev mode)",
          firebaseErrorCode: null,
        });
        return res.status(403).json({
          error: "forbidden",
          message: "スーパー管理者権限が必要です",
        });
      }

      req.superAdmin = { email: headerEmail.toLowerCase() };
      return next();
    } catch (error) {
      // Issue #293: Firestore 障害時は env に載っていない super-admin を silent に 403 で
      // 締め出さず、503 を返して再試行を促す。
      if (error instanceof SuperAdminFirestoreUnavailableError) {
        logger.error("Super admin Firestore check unavailable", {
          errorType: "super_admin_firestore_unavailable",
          authMode: "dev",
          firebaseErrorCode: error.code ?? null,
          path: req.path,
          method: req.method,
        });
        return res.status(503).json({
          error: "service_unavailable",
          message: "一時的に利用できません。再度お試しください。",
        });
      }
      throw error;
    }
  }

  if (authMode === "firebase") {
    // Firebase認証: Authorization: Bearer <ID Token>
    const authHeader = req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      await recordSuperAdminAuthEvent(req, {
        errorType: "super_admin_denied",
        reason: "no_auth_header",
        email: undefined,
        errorMessage: "Authorization header missing or not Bearer",
        firebaseErrorCode: null,
      });
      return res.status(401).json({
        error: "unauthorized",
        message: "認証情報がありません",
      });
    }

    const idToken = authHeader.slice(7);
    try {
      // Issue #289 / ADR-031 allowed_emails 境界:
      //   #1: email_verified=true 必須（未検証メール詐称の防止）
      //   #2: sign_in_provider=google.com のみ許可（IdP 追加時の allowlist バイパス防止）
      //   + checkRevoked=true で B-1「即時失効」を super-admin 経路にも適用
      // いずれも super-admin 判定より前に実行してホワイトリスト主義を徹底する。
      // レスポンス文言は既存の 403「スーパー管理者権限が必要です」で統一（ユーザー列挙防止）。
      const decodedToken = await getAuth().verifyIdToken(idToken, true);

      if (decodedToken.email_verified !== true) {
        await recordSuperAdminAuthEvent(req, {
          errorType: "super_admin_denied",
          reason: "email_not_verified",
          email: decodedToken.email,
          errorMessage: `Email verification required (uid=${decodedToken.uid})`,
          firebaseErrorCode: null,
        });
        return res.status(403).json({
          error: "forbidden",
          message: "スーパー管理者権限が必要です",
        });
      }
      if (decodedToken.firebase?.sign_in_provider !== "google.com") {
        await recordSuperAdminAuthEvent(req, {
          errorType: "super_admin_denied",
          reason: "non_google_provider",
          email: decodedToken.email,
          errorMessage: `Only Google sign-in is allowed (provider=${decodedToken.firebase?.sign_in_provider ?? "unknown"})`,
          firebaseErrorCode: null,
        });
        return res.status(403).json({
          error: "forbidden",
          message: "スーパー管理者権限が必要です",
        });
      }

      const email = decodedToken.email;
      // Google sign-in なら email は必須だが、将来の SDK 仕様変更や特殊トークンで
      // 欠落した場合は fail-closed で 403 を返し、non-null assertion による
      // サイレント TypeError を防ぐ。
      if (!email) {
        await recordSuperAdminAuthEvent(req, {
          errorType: "super_admin_denied",
          reason: "email_missing",
          email: undefined,
          errorMessage: `Decoded token is missing email claim (uid=${decodedToken.uid})`,
          firebaseErrorCode: null,
        });
        return res.status(403).json({
          error: "forbidden",
          message: "スーパー管理者権限が必要です",
        });
      }

      const isAdmin = await isSuperAdmin(email);
      if (!isAdmin) {
        await recordSuperAdminAuthEvent(req, {
          errorType: "super_admin_denied",
          reason: "not_super_admin",
          email,
          errorMessage: "Email not registered as super admin",
          firebaseErrorCode: null,
        });
        return res.status(403).json({
          error: "forbidden",
          message: "スーパー管理者権限が必要です",
        });
      }

      req.superAdmin = {
        email: email.toLowerCase(),
        firebaseUid: decodedToken.uid,
      };
      return next();
    } catch (error) {
      // Issue #293: Firestore 障害時は 503 で返す（env フォールバックで既に通過済みの
      // ケースはここに来ない）。通常の token 検証失敗は従来通り 401。
      if (error instanceof SuperAdminFirestoreUnavailableError) {
        logger.error("Super admin Firestore check unavailable", {
          errorType: "super_admin_firestore_unavailable",
          authMode: "firebase",
          firebaseErrorCode: error.code ?? null,
          path: req.path,
          method: req.method,
        });
        return res.status(503).json({
          error: "service_unavailable",
          message: "一時的に利用できません。再度お試しください。",
        });
      }
      // Issue #292: verifyIdToken 失敗を構造化ログ + platform_auth_error_logs に記録。
      // firebaseErrorCode (auth/id-token-revoked, auth/id-token-expired, auth/internal-error 等) で
      // 原因を機械的に区別できるようにする。
      const err = error as { code?: unknown; message?: unknown };
      const firebaseErrorCode = typeof err.code === "string" ? err.code : null;
      const errorMessage = typeof err.message === "string" ? err.message : String(error);
      await recordSuperAdminAuthEvent(req, {
        errorType: "super_admin_token_error",
        reason: null,
        email: undefined,
        errorMessage,
        firebaseErrorCode,
      });
      return res.status(401).json({
        error: "unauthorized",
        message: "認証に失敗しました",
      });
    }
  }

  // 不明なAUTH_MODEの場合
  return res.status(500).json({
    error: "internal_error",
    message: "不明な認証モードです",
  });
};
