import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { encryptWithKey } from "./crypto/aes-gcm.js";

/**
 * Secret Manager から Firebaseリフレッシュトークン暗号化用の鍵環を取得する。
 * signing-keys.ts (OIDC署名鍵) とは別のシークレットを使い、ローテーション影響
 * 範囲を分離する（計画 linear-zooming-conway.md「PR A」節参照）。
 */

const AES_256_KEY_BYTES = 32;

let secretManagerClient: SecretManagerServiceClient | null = null;

export interface CredentialKeyEntry {
  version: number;
  key: Buffer;
}

export interface CredentialKeyring {
  keys: CredentialKeyEntry[];
  activeVersion: number;
}

interface RawCredentialKeyEntry {
  version: number;
  key: string;
}

function isRawCredentialKeyEntry(value: unknown): value is RawCredentialKeyEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.version === "number" && typeof entry.key === "string";
}

function validateCredentialKeyring(parsed: unknown): CredentialKeyring {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("mcp-credential-encryption-key secret is not a JSON object");
  }
  const candidate = parsed as { keys?: unknown; activeVersion?: unknown };

  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0 || !candidate.keys.every(isRawCredentialKeyEntry)) {
    throw new Error("mcp-credential-encryption-key secret is missing a valid keys array");
  }

  const keys: CredentialKeyEntry[] = candidate.keys.map((raw) => {
    const key = Buffer.from(raw.key, "base64");
    if (key.length !== AES_256_KEY_BYTES) {
      throw new Error(`mcp-credential-encryption-key entry (version=${raw.version}) is not a 32-byte AES-256 key`);
    }
    return { version: raw.version, key };
  });

  if (typeof candidate.activeVersion !== "number") {
    throw new Error("mcp-credential-encryption-key secret is missing a valid activeVersion");
  }
  if (!keys.some((k) => k.version === candidate.activeVersion)) {
    throw new Error("mcp-credential-encryption-key secret activeVersion does not match any key in keys");
  }

  return { keys, activeVersion: candidate.activeVersion };
}

/**
 * 鍵環の activeVersion の鍵で暗号化する（router.ts のサインイン時保存・
 * credential-service.ts のローテート後再保存の双方から使う共通ヘルパー）。
 */
export function encryptWithActiveKey(plaintext: string, keyring: CredentialKeyring): string {
  const activeKey = keyring.keys.find((k) => k.version === keyring.activeVersion);
  if (!activeKey) {
    throw new Error(`keyring has no key for activeVersion=${keyring.activeVersion}`);
  }
  return encryptWithKey(plaintext, activeKey.key, keyring.activeVersion);
}

/**
 * @param secretName Secret Manager の完全リソース名（`projects/{id}/secrets/{name}/versions/latest`）
 */
export async function getCredentialKeysFromSecretManager(secretName: string): Promise<CredentialKeyring> {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const [version] = await secretManagerClient.accessSecretVersion({ name: secretName });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`mcp-credential-encryption-key not found in Secret Manager (${secretName})`);
  }
  const raw = typeof payload === "string" ? payload : payload.toString();
  const parsed = JSON.parse(raw) as unknown;
  return validateCredentialKeyring(parsed);
}
