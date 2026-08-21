import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

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

export class FirebaseSignInError extends Error {}

export interface VerifiedGoogleAccount {
  uid: string;
  email: string;
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
  } catch {
    throw new FirebaseSignInError("Firebase ID token の検証に失敗しました");
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
