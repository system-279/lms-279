import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

/**
 * Secret Manager から oidc-provider 用の署名鍵(jwks)+cookie署名鍵を取得する。
 * services/api/src/services/google-auth.ts の getDwdKeyFromSecretManager() と同型
 * (モジュールレベル lazy singleton の SecretManagerServiceClient、完全リソース名、
 * payload欠落時に throw、JSON.parse)。
 *
 * このリポジトリの Cloud Run デプロイは --set-secrets を使わず、シークレットは
 * ランタイムSDKで都度取得する方式(services/apiのDWD鍵と同型)。GitHub Actionsの
 * secrets.* はSecret Managerのリソース名を渡すだけで、値そのものはCloud Run環境変数に
 * 載せない(計画 noble-purring-rabbit.md 参照)。
 */

let secretManagerClient: SecretManagerServiceClient | null = null;

export interface JwkKey {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  [key: string]: unknown;
}

export interface McpSigningKeys {
  jwks: { keys: JwkKey[] };
  cookieKeys: string[];
}

function isJwkKey(value: unknown): value is JwkKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return typeof key.kty === "string" && typeof key.kid === "string" && typeof key.use === "string" && typeof key.alg === "string";
}

function validateSigningKeys(parsed: unknown): McpSigningKeys {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("mcp-oauth-signing-key secret is not a JSON object");
  }
  const candidate = parsed as { jwks?: unknown; cookieKeys?: unknown };

  const jwks = candidate.jwks as { keys?: unknown } | undefined;
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0 || !jwks.keys.every(isJwkKey)) {
    throw new Error("mcp-oauth-signing-key secret is missing a valid jwks.keys array");
  }

  const cookieKeys = candidate.cookieKeys;
  if (!Array.isArray(cookieKeys) || cookieKeys.length === 0 || !cookieKeys.every((k) => typeof k === "string" && k.length > 0)) {
    throw new Error("mcp-oauth-signing-key secret is missing a valid cookieKeys array");
  }

  return { jwks: jwks as { keys: JwkKey[] }, cookieKeys };
}

/**
 * @param secretName Secret Manager の完全リソース名（`projects/{id}/secrets/{name}/versions/latest`）
 */
export async function getSigningKeysFromSecretManager(secretName: string): Promise<McpSigningKeys> {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const [version] = await secretManagerClient.accessSecretVersion({ name: secretName });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`mcp-oauth-signing-key not found in Secret Manager (${secretName})`);
  }
  const raw = typeof payload === "string" ? payload : payload.toString();
  const parsed = JSON.parse(raw) as unknown;
  return validateSigningKeys(parsed);
}
