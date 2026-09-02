/**
 * Secret Manager からのシークレット取得。
 *
 * services/mcp/src/signing-keys.ts の getSigningKeysFromSecretManager() と同型
 * (モジュールレベル lazy singleton の SecretManagerServiceClient、完全リソース名で取得)。
 * このリポジトリの Cloud Run デプロイは --set-secrets を使わず、シークレットは
 * ランタイム SDK で都度取得する方式(services/api の DWD 鍵と同型)。
 */

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

let secretManagerClient: SecretManagerServiceClient | null = null;

/**
 * @param secretName Secret Manager の完全リソース名
 *   （`projects/{id}/secrets/{name}/versions/latest`）
 */
export async function getSecretValue(secretName: string): Promise<string> {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const [version] = await secretManagerClient.accessSecretVersion({
    name: secretName,
  });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`Secret payload is empty (${secretName})`);
  }
  return typeof payload === "string" ? payload : payload.toString();
}
