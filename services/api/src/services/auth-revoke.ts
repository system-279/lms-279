/**
 * Firebase Auth セッション失効ヘルパー
 * allowed_emails から削除されたユーザーの refresh token を即時失効させる。
 *
 * AUTH_MODE=firebase のみ実アクションを行い、dev モードでは no-op。
 */
import { getAuth } from "firebase-admin/auth";
import { logger } from "../utils/logger.js";

export async function revokeRefreshTokensByEmail(email: string): Promise<void> {
  const authMode = process.env.AUTH_MODE ?? "dev";
  if (authMode !== "firebase") {
    logger.info("revokeRefreshTokens skipped (non-firebase AUTH_MODE)", {
      email,
      authMode,
    });
    return;
  }

  try {
    const user = await getAuth().getUserByEmail(email);
    await getAuth().revokeRefreshTokens(user.uid);
    logger.info("Refresh tokens revoked", { email, uid: user.uid });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/user-not-found") {
      logger.info("No Firebase Auth user for email; revoke skipped", { email });
      return;
    }
    throw error;
  }
}
