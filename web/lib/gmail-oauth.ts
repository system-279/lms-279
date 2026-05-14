"use client";

/**
 * Phase 2: Gmail 下書き作成のための OAuth access token 取得。
 *
 * ADR-034 §3 に準拠。Firebase Authentication の GoogleAuthProvider に
 * gmail.compose scope を追加して popup で同意を取り、access token を取得する。
 *
 * 設計判断:
 * - access token は per-request で取得し、サーバーに送って即破棄 (BE で保持しない)
 * - refresh token は要求しない (access_type=online)
 * - dev モードでは利用不可 (GmailOAuthError("auth_disabled"))
 */

import {
  GoogleAuthProvider,
  reauthenticateWithPopup,
  signInWithPopup,
} from "firebase/auth";
import { getFirebaseAuth } from "./firebase";

export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";

export type GmailOAuthErrorCode =
  | "popup_closed"
  | "popup_blocked"
  | "auth_disabled"
  | "no_access_token"
  | "unknown";

export class GmailOAuthError extends Error {
  constructor(message: string, public code: GmailOAuthErrorCode) {
    super(message);
    this.name = "GmailOAuthError";
  }
}

/**
 * gmail.compose scope を含む Google OAuth popup を起動し access token を取得する。
 *
 * - 既存セッションがあれば reauthenticateWithPopup (UX 自然)
 * - 未ログインなら signInWithPopup (実運用ではここに到達しない想定)
 *
 * @throws GmailOAuthError popup キャンセル / ブロック / dev モード / 不明エラー
 */
export async function requestGmailComposeAccessToken(): Promise<string> {
  if (AUTH_MODE !== "firebase") {
    throw new GmailOAuthError(
      "Gmail 連携は本番認証モードでのみ利用できます",
      "auth_disabled",
    );
  }

  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.addScope(GMAIL_COMPOSE_SCOPE);

  try {
    const currentUser = auth.currentUser;
    const result = currentUser
      ? await reauthenticateWithPopup(currentUser, provider)
      : await signInWithPopup(auth, provider);

    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;

    if (!accessToken) {
      throw new GmailOAuthError(
        "Google OAuth から access token を取得できませんでした",
        "no_access_token",
      );
    }

    return accessToken;
  } catch (err) {
    if (err instanceof GmailOAuthError) throw err;
    const code = (err as { code?: string }).code;
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      throw new GmailOAuthError(
        "Google 認証ポップアップが閉じられました",
        "popup_closed",
      );
    }
    if (code === "auth/popup-blocked") {
      throw new GmailOAuthError(
        "ブラウザがポップアップをブロックしました。ポップアップを許可してください",
        "popup_blocked",
      );
    }
    throw new GmailOAuthError(
      err instanceof Error ? err.message : "Gmail OAuth 認証に失敗しました",
      "unknown",
    );
  }
}
