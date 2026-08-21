import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { logger } from "./logger.js";

/**
 * services/api/src/middleware/super-admin.ts:124-135 と同じ初期化パターン。
 * MCP 側は Firebase Console 上の認証情報検証のみに使うため
 * GOOGLE_APPLICATION_CREDENTIALS 分岐は不要（Cloud Run 既定 compute SA の
 * Application Default Credentials で足りる。Firestore アクセス等の権限拡張は
 * Phase 1b で最小権限 SA を設計する際に再検討する）。
 */
function ensureFirebaseApp(): void {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
    initializeApp({ projectId });
  }
}

/**
 * transient=true は firebase-admin 側の一時的な不調（ネットワーク/タイムアウト/
 * 内部エラー）を示す。呼び出し元（router.ts）はこれを 503（リトライ可能）、
 * それ以外（期限切れ・失効・provider不一致等の呼び出し者起因）は 403 として返す。
 */
export class FirebaseSignInError extends Error {
  constructor(
    message: string,
    readonly transient = false
  ) {
    super(message);
  }
}

export interface VerifiedGoogleAccount {
  uid: string;
  email: string;
}

function isTransientFirebaseErrorCode(code: string | undefined): boolean {
  return code !== undefined && /network|timeout|internal-error/i.test(code);
}

/**
 * Google Firebase ID token を検証し、真正な Google アカウントによるサインインで
 * あることを確認する。tenant-auth.ts:395-411 と同一のガード（email_verified /
 * sign_in_provider）。メールドメイン制限（hd 等）は本サービスでは行わない
 * （計画ファイル「MCP 認可サーバー自身はメールドメイン検証をしない」節参照。
 * 認可の実体は Phase 2 で quiz ツールが services/api を呼ぶ際の allowed_emails
 * チェックに委ねる）。
 */
export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleAccount> {
  ensureFirebaseApp();

  let decodedToken;
  try {
    decodedToken = await getAuth().verifyIdToken(idToken, true);
  } catch (error) {
    const err = error as { code?: unknown; message?: unknown };
    const code = typeof err.code === "string" ? err.code : undefined;
    // expired/revoked/malformedトークンは日常的に起きうるためinfoログに留め、
    // ネットワーク/内部エラー等サーバー起因の疑いがある場合のみerrorログにする
    // (rules/error-handling.md §3 transient/permanent分類)。
    const transient = isTransientFirebaseErrorCode(code);
    logger[transient ? "error" : "info"]("Firebase ID token verification failed", {
      firebaseErrorCode: code ?? null,
      errorMessage: typeof err.message === "string" ? err.message : String(error),
      transient,
    });
    throw new FirebaseSignInError("Firebase ID token の検証に失敗しました", transient);
  }

  if (decodedToken.email_verified !== true) {
    throw new FirebaseSignInError("メールアドレスが未検証です");
  }
  if (decodedToken.firebase?.sign_in_provider !== "google.com") {
    throw new FirebaseSignInError("Google サインインのみ許可されています");
  }
  const email = decodedToken.email?.trim().toLowerCase();
  if (!email) {
    throw new FirebaseSignInError("メールアドレスが取得できませんでした");
  }

  return { uid: decodedToken.uid, email };
}
