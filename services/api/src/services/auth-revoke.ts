/**
 * Firebase Auth セッション失効ヘルパー
 * allowed_emails から削除されたユーザーの refresh token を即時失効させる。
 *
 * AUTH_MODE=firebase のみ実アクションを行い、dev モードでは no-op。
 *
 * 設計上の注意（silent-failure-hunter C-1 対応）:
 * - getUserByEmail と revokeRefreshTokens の try/catch は分離する。
 *   両方を同じ catch に入れると、revoke 側の `auth/user-not-found`（競合状態で
 *   対象 UID が別プロセスに削除された場合など）がサイレントに「スキップ」扱いになり、
 *   本来 revoke されていない事実が隠蔽される。
 */
import { getAuth } from "firebase-admin/auth";
import { logger } from "../utils/logger.js";

export async function revokeRefreshTokensByEmail(email: string): Promise<void> {
  const authMode = process.env.AUTH_MODE ?? "dev";
  if (authMode !== "firebase") {
    logger.debug("revokeRefreshTokens skipped (non-firebase AUTH_MODE)", {
      email,
      authMode,
    });
    return;
  }

  const normalized = email.trim().toLowerCase();

  // getUserByEmail のエラーのみ user-not-found を no-op として許容する
  let user;
  try {
    user = await getAuth().getUserByEmail(normalized);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/user-not-found") {
      logger.warn("No Firebase Auth user for email; revoke skipped", { email: normalized });
      return;
    }
    throw error;
  }

  // revoke 側の失敗は必ず呼び出し側まで伝搬させる。
  // （ベストエフォートにするかは呼び出し側で判断する）
  await getAuth().revokeRefreshTokens(user.uid);
  logger.info("Refresh tokens revoked", { email: normalized });
}
