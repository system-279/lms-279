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

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new TokenExchangeError(`Firebase refresh token交換の応答がJSONとして解釈できません: ${String(error)}`, false);
  }

  return validateExchangedTokens(body);
}

/**
 * 200応答でも id_token/refresh_token/expires_in が欠落・不正な値の場合がある
 * (レビュー指摘: パース不能や必須フィールド欠落を無検証で通すと undefined を
 * 「成功」として返してしまい、以後の呼び出し元すべてに静かに伝播する)。
 * ここで必ず検証し、不正な応答は permanent な TokenExchangeError として扱う。
 */
function validateExchangedTokens(body: unknown): ExchangedTokens {
  if (typeof body !== "object" || body === null) {
    throw new TokenExchangeError("Firebase refresh token交換の応答が不正な形式です", false);
  }
  const candidate = body as { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

  if (typeof candidate.id_token !== "string" || candidate.id_token.length === 0) {
    throw new TokenExchangeError("Firebase refresh token交換の応答に id_token が含まれていません", false);
  }
  if (typeof candidate.refresh_token !== "string" || candidate.refresh_token.length === 0) {
    throw new TokenExchangeError("Firebase refresh token交換の応答に refresh_token が含まれていません", false);
  }
  const expiresIn = Number(candidate.expires_in);
  if (!Number.isFinite(expiresIn)) {
    throw new TokenExchangeError("Firebase refresh token交換の応答の expires_in が数値ではありません", false);
  }

  return { idToken: candidate.id_token, refreshToken: candidate.refresh_token, expiresIn };
}
