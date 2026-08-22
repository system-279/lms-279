import type { OidcProviderOptions } from "./oidc.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { getFirestoreDb } from "./firebase.js";
import { createFirestoreAdapterFactory } from "./storage/firestore-adapter.js";
import { getSigningKeysFromSecretManager } from "./signing-keys.js";

async function buildStorageOptions(config: ReturnType<typeof loadConfig>): Promise<OidcProviderOptions> {
  if (config.storage !== "firestore") {
    return {};
  }
  // loadConfig() の production runtime fail-fast により、storage==="firestore" のときは
  // mcpSigningSecretName が必ず設定されている。
  const secretName = config.mcpSigningSecretName!;
  const { jwks, cookieKeys } = await getSigningKeysFromSecretManager(secretName);
  const db = getFirestoreDb();
  return {
    adapter: createFirestoreAdapterFactory(db),
    jwks,
    cookieKeys,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const storageOptions = await buildStorageOptions(config);

  const { app } = await createApp(
    config.issuerUrl,
    config.port,
    {
      apiKey: config.firebaseWebApiKey ?? "",
      authDomain: config.firebaseAuthDomain ?? "",
      projectId: config.firebaseProjectId ?? "",
    },
    storageOptions
  );

  app.listen(config.port, () => {
    console.log(`lms-279 mcp listening on ${config.issuerUrl}`);
  });
}

main().catch((err) => {
  console.error("failed to start mcp service", err);
  process.exit(1);
});
