import type { OidcProviderOptions } from "./oidc.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { getFirestoreDb } from "./firebase.js";
import { createFirestoreAdapterFactory } from "./storage/firestore-adapter.js";
import { getSigningKeysFromSecretManager } from "./signing-keys.js";
import { getCredentialKeysFromSecretManager } from "./credential-keys.js";
import { createCredentialStore } from "./storage/credential-store.js";
import type { CredentialOptions } from "./interactions/router.js";
import { createCredentialService } from "./credential-service.js";
import { createLmsApiClient } from "./lms-api-client.js";
import { createAuditLog } from "./audit-log.js";
import type { McpServerDeps } from "./mcp-server.js";

async function buildStorageOptions(config: ReturnType<typeof loadConfig>): Promise<OidcProviderOptions> {
  if (config.storage !== "firestore") {
    return {};
  }
  // loadConfig() の production runtime fail-fast は NODE_ENV=production/K_SERVICE
  // 検出時のみ働く。MCP_STORAGE=firestore だけをローカル/CIで設定し
  // MCP_SIGNING_SECRET_NAME を設定し忘れるケース(production runtime外)はこの
  // fail-fastを素通りするため、ここでも独立してチェックする
  // (pr-review-toolkitセカンドオピニオン指摘、2026-08-22)。
  if (!config.mcpSigningSecretName) {
    throw new Error(
      "FATAL: MCP_STORAGE=firestore requires MCP_SIGNING_SECRET_NAME to be set (services/mcp/src/config.ts)。"
    );
  }
  const { jwks, cookieKeys } = await getSigningKeysFromSecretManager(config.mcpSigningSecretName);
  const db = getFirestoreDb();
  return {
    adapter: createFirestoreAdapterFactory(db),
    jwks,
    cookieKeys,
  };
}

/**
 * Phase 1b-1: MCP_STORAGE=firestore の場合のみ、Firebaseリフレッシュトークン
 * 暗号化用の鍵環を取得する。buildStorageOptions と同じ理由でここでも独立して
 * MCP_CREDENTIAL_SECRET_NAME の欠落をチェックする。
 */
async function buildCredentialOptions(config: ReturnType<typeof loadConfig>): Promise<CredentialOptions | undefined> {
  if (config.storage !== "firestore") {
    return undefined;
  }
  if (!config.mcpCredentialSecretName) {
    throw new Error(
      "FATAL: MCP_STORAGE=firestore requires MCP_CREDENTIAL_SECRET_NAME to be set (services/mcp/src/config.ts)。"
    );
  }
  const keyring = await getCredentialKeysFromSecretManager(config.mcpCredentialSecretName);
  const db = getFirestoreDb();
  return { store: createCredentialStore(db), keyring };
}

/**
 * Phase 2a: quizツール（list_courses/list_lessons/get_quiz）が依存するサービス群を
 * 組み立てる。credentialOptions（PR A、Firestore永続化）が無ければ資格情報を
 * 交換する手段がなくツールを提供できないため、その場合は undefined を返し
 * mcp-server.ts 側で ping のみ登録させる。
 */
async function buildMcpServerDeps(
  config: ReturnType<typeof loadConfig>,
  credentialOptions: CredentialOptions | undefined
): Promise<McpServerDeps | undefined> {
  if (config.storage !== "firestore" || !credentialOptions) {
    return undefined;
  }
  if (!config.lmsApiBaseUrl) {
    throw new Error("FATAL: MCP_STORAGE=firestore requires LMS_API_BASE_URL to be set (services/mcp/src/config.ts)。");
  }
  const credentialService = createCredentialService({
    store: credentialOptions.store,
    keyring: credentialOptions.keyring,
    firebaseWebApiKey: config.firebaseWebApiKey ?? "",
  });
  const lmsApiClient = createLmsApiClient(config.lmsApiBaseUrl);
  const auditLog = createAuditLog(getFirestoreDb());
  return { lmsApiClient, credentialService, auditLog };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const storageOptions = await buildStorageOptions(config);
  const credentialOptions = await buildCredentialOptions(config);
  const mcpServerDeps = await buildMcpServerDeps(config, credentialOptions);

  const { app } = await createApp(
    config.issuerUrl,
    config.port,
    {
      apiKey: config.firebaseWebApiKey ?? "",
      authDomain: config.firebaseAuthDomain ?? "",
      projectId: config.firebaseProjectId ?? "",
    },
    storageOptions,
    credentialOptions,
    mcpServerDeps
  );

  app.listen(config.port, () => {
    console.log(`lms-279 mcp listening on ${config.issuerUrl}`);
  });
}

main().catch((err) => {
  console.error("failed to start mcp service", err);
  process.exit(1);
});
