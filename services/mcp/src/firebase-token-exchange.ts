/**
 * Firebaseリフレッシュトークンを securetoken.googleapis.com/v1/token で新しい
 * IDトークンへ交換する。Googleは交換のたびに refresh_token をローテートするため
 * (公式挙動)、呼び出し元は返却された新しい refreshToken を必ず再保存すること。
 *
 * エラー分類は rules/error-handling.md §3 準拠:
 * transient = ネットワーク/5xx/429、permanent = 400 invalid_grant（失効）等。
 */

const TOKEN_ENDPOINT = "https://securetoken.googleapis.com/v1/token";

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    readonly transient: boolean
  ) {
    super(message);
  }
}

export interface ExchangedTokens {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function exchangeRefreshToken(refreshToken: string, apiKey: string): Promise<ExchangedTokens> {
  let response: Response;
  try {
    response = await fetch(`${TOKEN_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new TokenExchangeError(`Firebase refresh token交換のネットワークエラー: ${String(error)}`, true);
  }

  if (!response.ok) {
    throw new TokenExchangeError(
      `Firebase refresh token交換が失敗しました (status=${response.status})`,
      isTransientStatus(response.status)
    );
  }

  const body = (await response.json()) as { id_token: string; refresh_token: string; expires_in: string };
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in),
  };
}
