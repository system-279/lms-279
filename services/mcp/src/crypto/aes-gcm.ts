import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * リフレッシュトークン等の機微情報を AES-256-GCM で暗号化する。バージョン付き
 * フォーマットで鍵をローテーションしても旧バージョンの暗号文を復号できるように
 * する（元計画「鍵ローテーションはリリースゲート」節に対応）。
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

export interface KeyringEntry {
  version: number;
  key: Buffer;
}

interface EncryptedEnvelope {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

export function encryptWithKey(plaintext: string, key: Buffer, version: number): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    v: version,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    data: encrypted.toString("base64url"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decryptWithKeyring(ciphertext: string, keyring: KeyringEntry[]): string {
  const envelope = JSON.parse(Buffer.from(ciphertext, "base64url").toString("utf8")) as EncryptedEnvelope;

  const entry = keyring.find((k) => k.version === envelope.v);
  if (!entry) {
    throw new Error(`No key found in keyring for version ${envelope.v}`);
  }

  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  const data = Buffer.from(envelope.data, "base64url");

  const decipher = createDecipheriv(ALGORITHM, entry.key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
